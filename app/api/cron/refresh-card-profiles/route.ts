/**
 * Cron: refresh-card-profiles
 *
 * Generates AI-powered per-card summaries and stores them in
 * public.card_profiles. Operates in three modes:
 *
 *   backfill  – Fills profiles for cards that have none yet.
 *   refresh   – Tiered re-generation, prioritised by the RPC:
 *               1. High-priority (abs(change_pct_7d) >= 5% or liquidity >= 50):
 *                  refreshed every p_stale_days regardless of hash change.
 *               2. Low-priority: refreshed only when the price hash changes.
 *               3. Fallback upgrades: always processed, high-priority first.
 *   auto      – Runs backfill first (up to ?maxBackfillCards, default 2)
 *               then refresh (up to ?maxRefreshCards, default 8) within
 *               a single tick. Lets one hourly cron entry cover both
 *               mode responsibilities — the alternative would be two
 *               separate cron entries chewing up Vercel cron-quota slots.
 *               Use this from vercel.json; use the explicit backfill /
 *               refresh modes for manual one-shot operator runs.
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
  buildFallbackProfile,
  type CardProfileInput,
} from "@/lib/ai/card-profile-summary";

export const runtime = "nodejs";
export const maxDuration = 180;

const DEADLINE_RESERVE_MS = 20_000;
const DEFAULT_MAX_CARDS = 25;
const DEFAULT_MAX_BACKFILL_CARDS = 2;
const DEFAULT_MAX_REFRESH_CARDS = 8;
const MAX_OPERATOR_BATCH_CARDS = 250;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_BATCH_SIZE = 10;
const STALE_DAYS = 7;
const BATCH_HALTING_LLM_FAILURE_MARKERS = [
  "api key",
  "billing",
  "credits",
  "current quota",
  "forbidden",
  "insufficient funds",
  "monthly spending cap",
  "not available",
  "not found",
  "permission",
  "quota",
  "rate limit",
  "resource_exhausted",
  "spending cap",
  "unauthorized",
];

function parseOptionalInt(value: string | null, min: number, max: number, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function shouldHaltBatchForLlmFailure(reason: string | null | undefined): boolean {
  const normalized = reason?.toLowerCase() ?? "";
  if (!normalized.startsWith("llm-threw:")) return false;
  return BATCH_HALTING_LLM_FAILURE_MARKERS.some((marker) => normalized.includes(marker));
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
  existing_source?: string | null;
  is_high_priority?: boolean | null;
  // Card-level metadata returned by both selection RPCs as of
  // 20260503120100_card_profiles_refresh_rpc_add_metadata.sql.
  // Used by buildFallbackProfile to produce tier-aware copy.
  rarity?: string | null;
  year?: number | null;
  is_digital?: boolean | null;
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
    // DB column is named active_listings_7d for historical reasons but the
    // value is actually a count of fresh price observations (capped at 100),
    // not marketplace listings. Map to the accurate field name on the LLM
    // input so prompts don't mislead the model into writing "X listings".
    priceObservations7d: row.active_listings_7d,
    volatility30d: row.volatility_30d,
    liquidityScore: row.liquidity_score,
    conditionPrices,
    rarity: row.rarity ?? null,
    year: row.year ?? null,
    isDigital: row.is_digital ?? null,
    isHighPriority: row.is_high_priority ?? null,
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
        // failure_reason persists the reason a row landed on
        // source=fallback (parse-miss / llm-threw:<error>). The cron
        // already aggregates these in its HTTP response, but persisting
        // them lets the admin coverage view answer "of cards currently
        // on fallback, why did they get there?" days/weeks later.
        // Explicitly write null on source=llm so an upsert from
        // fallback → llm clears the reason column rather than leaking
        // a stale value.
        failure_reason: result.failureReason ?? null,
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
  // Absolute wall-clock cutoff (Date.now() ms). Once we cross it,
  // bail out of the inner concurrency loop instead of starting
  // another batch. Without this, a chunk that begins under-deadline
  // could still run past Vercel's maxDuration if the Gemini p95 is
  // long — Incident: 2026-04-26 504 FUNCTION_INVOCATION_TIMEOUT,
  // which is exactly what motivated moving the check inside.
  deadline: number,
): Promise<{
  llm: number;
  fallbacks: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  // Number of cards in `inputs` that we actually touched before
  // bailing on the deadline. The caller uses this to update its
  // running totals correctly when a chunk exits early.
  processed: number;
  // True when the inner loop broke out because Date.now() crossed
  // `deadline`. Lets the caller stop scheduling further work.
  hitDeadline: boolean;
  // First non-null failureReason seen in this chunk. Surfaces the
  // underlying LLM error (auth, model-not-found, rate-limit, parse-miss,
  // …) through the cron response instead of silently converting every
  // failure into a fallback and returning ok:true.
  firstFailureReason: string | null;
  failureReasonCounts: Record<string, number>;
  haltedForLlmProviderFailure: boolean;
  llmProviderFailureHaltReason: string | null;
}> {
  let llm = 0;
  let fallbacks = 0;
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let processed = 0;
  let hitDeadline = false;
  let firstFailureReason: string | null = null;
  let llmProviderFailureHaltReason: string | null = null;
  const failureReasonCounts: Record<string, number> = {};

  // Process in sliding windows of `concurrency`. The deadline is
  // checked at the start of each window so we can exit between
  // batches — granularity is `concurrency` cards × p95-latency ≈
  // ~5-12s instead of `batchSize` cards × p95-latency ≈ ~30-100s.
  for (let i = 0; i < inputs.length; i += concurrency) {
    if (Date.now() >= deadline) {
      hitDeadline = true;
      break;
    }
    const window = inputs.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      window.map((input) => generateCardProfile(input)),
    );

    for (let j = 0; j < results.length; j++) {
      const input = window[j];
      const settled = results[j];

      // generateCardProfile never throws (it catches internally and
      // returns a fallback-with-reason), so the "rejected" branch only
      // fires for truly unexpected crashes — keep it as a last resort.
      const profile =
        settled.status === "fulfilled"
          ? settled.value
          : {
              ...buildFallbackProfile(input),
              failureReason: `rejected:${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
            };

      try {
        await upsertProfile(supabase, input.canonicalSlug, profile);
        processed++;
        if (profile.source === "llm") {
          llm++;
          inputTokens += profile.inputTokens ?? 0;
          outputTokens += profile.outputTokens ?? 0;
        } else {
          fallbacks++;
          if (profile.failureReason) {
            if (!firstFailureReason) firstFailureReason = profile.failureReason;
            if (!llmProviderFailureHaltReason && shouldHaltBatchForLlmFailure(profile.failureReason)) {
              llmProviderFailureHaltReason = profile.failureReason;
            }
            // Bucket by the class prefix (llm-threw:<Name>, parse-miss,
            // rejected:…) so the summary stays compact — full messages
            // go to Vercel logs.
            const bucket = profile.failureReason.split(":").slice(0, 2).join(":");
            failureReasonCounts[bucket] = (failureReasonCounts[bucket] ?? 0) + 1;
          }
        }
      } catch {
        errors++;
      }
    }

    if (llmProviderFailureHaltReason) {
      break;
    }
  }

  return {
    llm,
    fallbacks,
    errors,
    inputTokens,
    outputTokens,
    processed,
    hitDeadline,
    firstFailureReason,
    failureReasonCounts,
    haltedForLlmProviderFailure: llmProviderFailureHaltReason !== null,
    llmProviderFailureHaltReason,
  };
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const deadline = startedAt + (maxDuration * 1000) - DEADLINE_RESERVE_MS;

  const url = new URL(req.url);
  const modeParam = url.searchParams.get("mode");
  const mode: "backfill" | "refresh" | "auto" =
    modeParam === "refresh" ? "refresh" : modeParam === "auto" ? "auto" : "backfill";
  const maxCardsParam = parseOptionalInt(
    url.searchParams.get("maxCards"),
    1,
    MAX_OPERATOR_BATCH_CARDS,
    DEFAULT_MAX_CARDS,
  );
  // Auto-mode split: separate budgets for the backfill and refresh phases
  // so neither starves the other. Defaults are intentionally below
  // maxCards because this cron runs hourly.
  const maxBackfillCards = parseOptionalInt(
    url.searchParams.get("maxBackfillCards"),
    1,
    MAX_OPERATOR_BATCH_CARDS,
    DEFAULT_MAX_BACKFILL_CARDS,
  );
  const maxRefreshCards = parseOptionalInt(
    url.searchParams.get("maxRefreshCards"),
    1,
    MAX_OPERATOR_BATCH_CARDS,
    DEFAULT_MAX_REFRESH_CARDS,
  );
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
  // True if any chunk exited mid-flight on the deadline check, OR
  // the outer loop broke before draining `cards`. Tells the operator
  // (or a wrapping drain loop) that there's more work to do — just
  // rerun the same URL.
  let truncatedAtDeadline = false;
  // LLM-path fingerprints: `llmFailureSample` is the first human-readable
  // failure string (e.g. "llm-threw:AI_APICallError:…"), and
  // `llmFailureBuckets` counts failures by class so a glance at the
  // response tells you "all 498 were AI_APICallError" vs. a mixed bag.
  let llmFailureSample: string | null = null;
  const llmFailureBuckets: Record<string, number> = {};
  let haltedForLlmProviderFailure = false;
  let llmProviderFailureHaltReason: string | null = null;

  // Drain a card list through the same deadline-aware chunk loop both
  // modes use. Updates the per-run totals + truncated flag via the
  // closure. Returns true if the deadline was hit (caller may decide
  // not to start a second phase).
  const drainCards = async (cards: typeof undefined extends never ? CardRow[] : CardRow[]): Promise<boolean> => {
    for (let i = 0; i < cards.length; i += batchSize) {
      if (Date.now() >= deadline) return true;
      const chunkCards = cards.slice(i, i + batchSize);
      const conditionMap = await fetchConditionPricesForSlugs(supabase, chunkCards.map((c) => c.canonical_slug));
      const chunk = chunkCards.map((c) => toProfileInput(c, conditionMap.get(c.canonical_slug) ?? null));
      const stats = await processChunk(supabase, chunk, concurrency, deadline);
      totalLlm += stats.llm;
      totalFallbacks += stats.fallbacks;
      totalErrors += stats.errors;
      totalInputTokens += stats.inputTokens;
      totalOutputTokens += stats.outputTokens;
      totalProcessed += stats.processed;
      if (!llmFailureSample && stats.firstFailureReason) {
        llmFailureSample = stats.firstFailureReason;
      }
      for (const [bucket, count] of Object.entries(stats.failureReasonCounts)) {
        llmFailureBuckets[bucket] = (llmFailureBuckets[bucket] ?? 0) + count;
      }
      if (stats.haltedForLlmProviderFailure) {
        haltedForLlmProviderFailure = true;
        llmProviderFailureHaltReason = stats.llmProviderFailureHaltReason;
        return true;
      }
      if (stats.hitDeadline) {
        truncatedAtDeadline = true;
        return true;
      }
    }
    if (Date.now() >= deadline) truncatedAtDeadline = true;
    return truncatedAtDeadline;
  };

  let autoBackfillProcessed = 0;
  let autoRefreshProcessed = 0;

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
      await drainCards(cards);
    } else if (mode === "refresh") {
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
      await drainCards(cards);
    } else {
      // auto mode: backfill phase first (capped to maxBackfillCards),
      // then refresh phase (capped to maxRefreshCards). Either phase
      // hitting the deadline stops the next one from starting.
      const backfillCards = await fetchBackfillCards(supabase, maxBackfillCards);
      const beforeBackfill = totalProcessed;
      let backfillHitDeadline = false;
      if (backfillCards.length > 0) {
        backfillHitDeadline = await drainCards(backfillCards);
      }
      autoBackfillProcessed = totalProcessed - beforeBackfill;

      if (!backfillHitDeadline && Date.now() < deadline) {
        const refreshCards = await fetchRefreshCards(supabase, maxRefreshCards);
        const beforeRefresh = totalProcessed;
        if (refreshCards.length > 0) {
          await drainCards(refreshCards);
        }
        autoRefreshProcessed = totalProcessed - beforeRefresh;
      }
    }
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
  }

  // ok is now a tighter predicate: infrastructure didn't throw AND at
  // least some cards actually hit the LLM. 100% fallback with zero
  // tokens — the prior silent-success shape — now returns ok:false so
  // the caller (or a future scheduled cron) can alert instead of
  // shrugging.
  const llmPathDegraded = totalProcessed > 0 && totalLlm === 0;
  const ok = firstError === null && !llmPathDegraded && !haltedForLlmProviderFailure;
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
      // Populated only when the LLM path had failures. On a healthy
      // run these will be null / empty.
      llmFailureSample,
      llmFailureBuckets: Object.keys(llmFailureBuckets).length ? llmFailureBuckets : null,
      llmPathDegraded,
      haltedForLlmProviderFailure,
      llmProviderFailureHaltReason,
      // True when this invocation exited early on the deadline guard
      // (either between chunks or mid-chunk via the inner check).
      // Operator should rerun the same URL to drain remaining work.
      truncatedAtDeadline,
      // Auto-mode phase breakdown — null for the explicit backfill/refresh
      // modes since they only ran one phase.
      autoBackfillProcessed: mode === "auto" ? autoBackfillProcessed : null,
      autoRefreshProcessed: mode === "auto" ? autoRefreshProcessed : null,
    },
    { status: ok ? 200 : 500 },
  );
}
