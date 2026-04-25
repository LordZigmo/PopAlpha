/**
 * Cron: refresh-card-profiles
 *
 * Generates AI-powered per-card summaries and stores them in
 * public.card_profiles. Operates in two modes:
 *
 *   backfill  – Fills profiles for cards that have none yet.
 *               Run every 3 hours until the full catalog is covered,
 *               then remove the cron entry.
 *   refresh   – Re-generates profiles whose underlying market data has
 *               changed (detected via metrics_hash) or that are older
 *               than 14 days. Runs daily.
 *
 * Each invocation processes up to `maxCards` cards, using `concurrency`
 * parallel Gemini calls. A deadline guard ensures the function exits
 * cleanly before the Vercel timeout.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  generateCardProfile,
  buildMetricsHash,
  buildFallbackProfile,
  type CardProfileInput,
} from "@/lib/ai/card-profile-summary";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEADLINE_RESERVE_MS = 30_000;
const DEFAULT_MAX_CARDS = 500;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_BATCH_SIZE = 50;
const STALE_DAYS = 1;

function parseOptionalInt(value: string | null, min: number, max: number, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

type CardRow = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  market_price: number | null;
  median_7d: number | null;
  median_30d: number | null;
  change_pct_7d: number | null;
  low_30d: number | null;
  high_30d: number | null;
  active_listings_7d: number | null;
  volatility_30d: number | null;
  liquidity_score: number | null;
};

type ConditionPriceRow = {
  canonical_slug: string;
  condition: string;
  price: number;
};

function toProfileInput(
  row: CardRow,
  conditionPrices: Array<{ condition: string; price: number }> | null,
): CardProfileInput {
  return {
    canonicalSlug: row.canonical_slug,
    canonicalName: row.canonical_name,
    setName: row.set_name,
    cardNumber: row.card_number,
    marketPrice: row.market_price,
    median7d: row.median_7d,
    median30d: row.median_30d,
    changePct7d: row.change_pct_7d,
    low30d: row.low_30d,
    high30d: row.high_30d,
    activeListings7d: row.active_listings_7d,
    volatility30d: row.volatility_30d,
    liquidityScore: row.liquidity_score,
    conditionPrices,
  };
}

async function fetchConditionPricesForSlugs(
  supabase: ReturnType<typeof dbAdmin>,
  slugs: string[],
): Promise<Map<string, Array<{ condition: string; price: number }>>> {
  if (slugs.length === 0) return new Map();
  const { data, error } = await supabase
    .from("card_condition_prices")
    .select("canonical_slug,condition,price")
    .in("canonical_slug", slugs)
    .order("condition");
  if (error) return new Map();
  const result = new Map<string, Array<{ condition: string; price: number }>>();
  for (const row of (data ?? []) as ConditionPriceRow[]) {
    const existing = result.get(row.canonical_slug) ?? [];
    existing.push({ condition: row.condition, price: Number(row.price) });
    result.set(row.canonical_slug, existing);
  }
  return result;
}

async function fetchBackfillCards(
  supabase: ReturnType<typeof dbAdmin>,
  limit: number,
): Promise<CardRow[]> {
  // Cards with market data but no profile yet.
  const { data, error } = await supabase.rpc("get_cards_missing_profiles", {
    p_limit: limit,
  });
  if (error) throw new Error(`get_cards_missing_profiles failed: ${error.message}`);
  return (data as CardRow[]) ?? [];
}

async function fetchRefreshCards(
  supabase: ReturnType<typeof dbAdmin>,
  limit: number,
): Promise<Array<CardRow & { existing_hash: string | null }>> {
  const { data, error } = await supabase.rpc("get_cards_needing_profile_refresh", {
    p_limit: limit,
    p_stale_days: STALE_DAYS,
  });
  if (error) throw new Error(`get_cards_needing_profile_refresh failed: ${error.message}`);
  return (data as Array<CardRow & { existing_hash: string | null }>) ?? [];
}

async function upsertProfile(
  supabase: ReturnType<typeof dbAdmin>,
  slug: string,
  result: ReturnType<typeof buildFallbackProfile>,
) {
  const { error } = await supabase
    .from("card_profiles")
    .upsert(
      {
        canonical_slug: slug,
        signal_label: result.signalLabel,
        verdict: result.verdict,
        chip: result.chip,
        summary_short: result.summaryShort,
        summary_long: result.summaryLong,
        source: result.source,
        model_label: result.modelLabel,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        metrics_hash: result.metricsHash,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "canonical_slug" },
    );
  if (error) throw new Error(`upsert card_profiles failed for ${slug}: ${error.message}`);
}

async function processChunk(
  supabase: ReturnType<typeof dbAdmin>,
  inputs: CardProfileInput[],
  concurrency: number,
): Promise<{ llm: number; fallbacks: number; errors: number; inputTokens: number; outputTokens: number }> {
  let llm = 0;
  let fallbacks = 0;
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  // Process in sliding windows of `concurrency`
  for (let i = 0; i < inputs.length; i += concurrency) {
    const window = inputs.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      window.map((input) => generateCardProfile(input)),
    );

    for (let j = 0; j < results.length; j++) {
      const input = window[j];
      const settled = results[j];

      let profile: ReturnType<typeof buildFallbackProfile>;
      if (settled.status === "fulfilled") {
        profile = settled.value;
      } else {
        profile = buildFallbackProfile(input);
      }

      try {
        await upsertProfile(supabase, input.canonicalSlug, profile);
        if (profile.source === "llm") {
          llm++;
          inputTokens += profile.inputTokens ?? 0;
          outputTokens += profile.outputTokens ?? 0;
        } else {
          fallbacks++;
        }
      } catch {
        errors++;
      }
    }
  }

  return { llm, fallbacks, errors, inputTokens, outputTokens };
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const deadline = startedAt + (maxDuration * 1000) - DEADLINE_RESERVE_MS;

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "refresh" ? "refresh" : "backfill";
  const maxCardsParam = parseOptionalInt(url.searchParams.get("maxCards"), 1, 2000, DEFAULT_MAX_CARDS);
  const concurrency = parseOptionalInt(url.searchParams.get("concurrency"), 1, 10, DEFAULT_CONCURRENCY);
  const batchSize = parseOptionalInt(url.searchParams.get("batchSize"), 10, 200, DEFAULT_BATCH_SIZE);

  const supabase = dbAdmin();
  let totalLlm = 0;
  let totalFallbacks = 0;
  let totalErrors = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalProcessed = 0;
  let firstError: string | null = null;

  try {
    if (mode === "backfill") {
      const cards = await fetchBackfillCards(supabase, maxCardsParam);
      if (cards.length === 0) {
        return NextResponse.json({
          ok: true,
          job: "refresh_card_profiles",
          mode,
          message: "No cards need backfill",
          totalProcessed: 0,
          durationMs: Date.now() - startedAt,
        });
      }

      for (let i = 0; i < cards.length; i += batchSize) {
        if (Date.now() >= deadline) break;
        const chunkCards = cards.slice(i, i + batchSize);
        const conditionMap = await fetchConditionPricesForSlugs(supabase, chunkCards.map((c) => c.canonical_slug));
        const chunk = chunkCards.map((c) => toProfileInput(c, conditionMap.get(c.canonical_slug) ?? null));
        const stats = await processChunk(supabase, chunk, concurrency);
        totalLlm += stats.llm;
        totalFallbacks += stats.fallbacks;
        totalErrors += stats.errors;
        totalInputTokens += stats.inputTokens;
        totalOutputTokens += stats.outputTokens;
        totalProcessed += chunk.length;
      }
    } else {
      // refresh mode
      const cards = await fetchRefreshCards(supabase, maxCardsParam);
      if (cards.length === 0) {
        return NextResponse.json({
          ok: true,
          job: "refresh_card_profiles",
          mode,
          message: "No cards need refresh",
          totalProcessed: 0,
          durationMs: Date.now() - startedAt,
        });
      }

      // Filter to cards whose hash actually changed
      const needsRefresh = cards.filter((row) => {
        const input = toProfileInput(row, null);
        const currentHash = buildMetricsHash(input);
        return row.existing_hash !== currentHash;
      });

      for (let i = 0; i < needsRefresh.length; i += batchSize) {
        if (Date.now() >= deadline) break;
        const chunkCards = needsRefresh.slice(i, i + batchSize);
        const conditionMap = await fetchConditionPricesForSlugs(supabase, chunkCards.map((c) => c.canonical_slug));
        const chunk = chunkCards.map((c) => toProfileInput(c, conditionMap.get(c.canonical_slug) ?? null));
        const stats = await processChunk(supabase, chunk, concurrency);
        totalLlm += stats.llm;
        totalFallbacks += stats.fallbacks;
        totalErrors += stats.errors;
        totalInputTokens += stats.inputTokens;
        totalOutputTokens += stats.outputTokens;
        totalProcessed += chunk.length;
      }
    }
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
  }

  const ok = firstError === null;
  return NextResponse.json(
    {
      ok,
      job: "refresh_card_profiles",
      mode,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      totalProcessed,
      llmGenerated: totalLlm,
      fallbacksUsed: totalFallbacks,
      errors: totalErrors,
      totalInputTokens,
      totalOutputTokens,
      firstError,
    },
    { status: ok ? 200 : 500 },
  );
}
