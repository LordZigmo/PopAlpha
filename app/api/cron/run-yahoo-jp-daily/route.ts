/**
 * Cron: run-yahoo-jp-daily
 *
 * Steady-state refresh of Yahoo! Auctions JP scraped prices. Picks the
 * N oldest-observed_at JP cards, runs the scrape + matcher + write
 * pipeline on each, and updates yahoo_jp_card_prices.
 *
 * This is the per-tick worker for the daily refresh cycle. The Day 4
 * one-shot backfill at scripts/run-yahoo-jp-pipeline.mjs gets every
 * matched JP card a first row; this cron keeps them fresh.
 *
 * Schedule: hourly (configured in vercel.json). At 50 cards/tick × 24
 * ticks/day = 1,200 refreshes/day. With ~14,800 matched JP cards, a
 * full catalog refresh cycle is ~12 days — adequate for sold-archive
 * data that updates over weeks, not minutes. Bumping the per-tick
 * budget would shorten the cycle but tighten the politeness budget.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 *
 * Why inline (not via pipeline_jobs queue): YAHOO_JP doesn't have the
 * provider_card_map indirection that SCRYDEX has — listings match
 * structurally via title parsing, not by provider_card_id lookup. The
 * pipeline_jobs queue + claim/process worker pattern would add layers
 * (job rows, claim/release, retries) for no benefit. A self-contained
 * cron tick is the right shape.
 *
 * Politeness:
 *   • 4s inter-card delay (matches the backfill orchestrator)
 *   • Sequential — concurrency=1 to keep Yahoo!'s detector quiet
 *   • Auto-halts the tick if 5 consecutive scrape failures (cheap
 *     trigger; the cron just exits and next hour's tick retries)
 *
 * Health: returns a stats payload the operator can grep for in
 * Vercel cron logs. Failures don't bubble up as errors — they're
 * counted in the response body so the cron itself stays "succeeded"
 * from Vercel's POV; the operator monitors the response body.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { scrapeYahooJp } from "@/scripts/scrape-yahoo-jp.mjs";
import { buildPrecisionQuery, selectMatched } from "@/lib/jp/matcher.mjs";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel hobby/pro tick ceiling

const DEFAULT_BATCH_SIZE = 50;
const INTER_CARD_DELAY_MS = 4000;
const MIN_SAMPLE_COUNT = 3; // require ≥3 raw sales for a confident median
const MIN_MATCH_SCORE = 0.5;
const REFRESH_AFTER_HOURS = 24 * 7; // 7 days — refresh cards older than this
const HALT_AFTER_CONSECUTIVE_SCRAPE_FAILS = 5; // tick exits early; next hour retries
const DEADLINE_RESERVE_MS = 30_000; // stop new cards if <30s left so the response can flush

// Mirror the JPY/USD rate used by the orchestrator + lib/pricing/fx.ts
// so the column matches what the rest of the app produces.
const DEFAULT_JPY_TO_USD_RATE = 0.0068;
const JPY_TO_USD = (() => {
  const raw = process.env.JPY_TO_USD_RATE;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JPY_TO_USD_RATE;
})();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type CardRow = {
  slug: string;
  canonical_name: string | null;
  canonical_name_native: string | null;
  set_name: string | null;
  set_name_native: string | null;
  card_number: string | null;
  year: number | null;
  language: string | null;
};

/**
 * Pick the N JP cards most in need of refresh. The query unions:
 *   • Cards with no yahoo_jp_card_prices row at all (NULL observed_at) —
 *     never been scraped, highest priority.
 *   • Cards with observed_at > REFRESH_AFTER_HOURS old.
 * Both filtered to JP-language + at least one MATCHED provider_card_map
 * (so we don't burn requests on cards Scrydex has zero observations
 * for, which strongly correlates with cards Yahoo! has no data for
 * either).
 *
 * Order: NULL observed_at first (initial fetches prioritized), then
 * oldest observed_at.
 */
async function pickRefreshCandidates(supabase: ReturnType<typeof dbAdmin>, limit: number): Promise<CardRow[]> {
  // Reverse-engineer: fetch slugs of cards that need refresh by joining
  // canonical_cards with provider_card_map (matched only) and LEFT-
  // joining yahoo_jp_card_prices to find old/missing rows. Doing it
  // as a single RPC would be cleaner but pure REST works for v0.
  const cutoffIso = new Date(Date.now() - REFRESH_AFTER_HOURS * 60 * 60 * 1000).toISOString();
  const baseSelect = "slug,canonical_name,canonical_name_native,set_name,set_name_native,card_number,year,language";

  // Step 1: get slugs from yahoo_jp_card_prices ordered by observed_at ASC
  // (oldest first; nulls naturally first via PostgREST default order).
  // Limit slightly larger than `limit` so we have headroom after the
  // skip-recent filter.
  const { data: stalePriceRows, error: stalePriceErr } = await supabase
    .from("yahoo_jp_card_prices")
    .select("canonical_slug,observed_at")
    .eq("grade", "RAW")
    .lt("observed_at", cutoffIso)
    .order("observed_at", { ascending: true, nullsFirst: true })
    .limit(limit * 2);
  if (stalePriceErr) throw new Error(`stale-price scan: ${stalePriceErr.message}`);

  const staleSlugs = (stalePriceRows ?? []).map((r) => r.canonical_slug);

  // Step 2: any matched JP cards that have NO yahoo_jp_card_prices row at
  // all (highest priority — never scraped).
  // We use a NOT-IN + JOIN combination via the inner join on
  // provider_card_map + an anti-join via NOT EXISTS pattern. PostgREST
  // doesn't expose NOT EXISTS directly; cleanest is to fetch all JP
  // matched slugs and subtract those already in yahoo_jp_card_prices.
  const { data: matchedJpRows, error: matchedJpErr } = await supabase
    .from("canonical_cards")
    .select(`${baseSelect},provider_card_map!inner(mapping_status)`)
    .eq("language", "JP")
    .eq("provider_card_map.mapping_status", "MATCHED")
    .order("created_at", { ascending: false })
    .limit(limit * 4);
  if (matchedJpErr) throw new Error(`matched-jp scan: ${matchedJpErr.message}`);

  const matchedJp = (matchedJpRows ?? []) as CardRow[];
  // Dedupe by slug
  const matchedJpBySlug = new Map<string, CardRow>();
  for (const row of matchedJp) if (!matchedJpBySlug.has(row.slug)) matchedJpBySlug.set(row.slug, row);

  // Slugs that already have ANY yahoo_jp_card_prices row (regardless of age)
  const { data: anyRows } = await supabase
    .from("yahoo_jp_card_prices")
    .select("canonical_slug")
    .eq("grade", "RAW");
  const everScraped = new Set((anyRows ?? []).map((r) => r.canonical_slug));

  // Initial-fetch candidates = matched JP slugs not yet in yahoo_jp_card_prices
  const initialFetchSlugs = [...matchedJpBySlug.keys()].filter((s) => !everScraped.has(s));

  // Build the final ordered list: initial fetches first, then stale refreshes.
  const orderedSlugs: string[] = [];
  const seen = new Set<string>();
  for (const slug of initialFetchSlugs) {
    if (orderedSlugs.length >= limit) break;
    if (seen.has(slug)) continue;
    seen.add(slug);
    orderedSlugs.push(slug);
  }
  for (const slug of staleSlugs) {
    if (orderedSlugs.length >= limit) break;
    if (seen.has(slug)) continue;
    seen.add(slug);
    orderedSlugs.push(slug);
  }

  // Step 3: fetch full card details for the chosen slugs
  if (orderedSlugs.length === 0) return [];
  const { data: cards, error: cardsErr } = await supabase
    .from("canonical_cards")
    .select(baseSelect)
    .in("slug", orderedSlugs);
  if (cardsErr) throw new Error(`canonical_cards lookup: ${cardsErr.message}`);
  // Preserve the ordering we computed
  const cardsBySlug = new Map<string, CardRow>();
  for (const row of (cards ?? []) as CardRow[]) cardsBySlug.set(row.slug, row);
  return orderedSlugs.map((s) => cardsBySlug.get(s)).filter((c): c is CardRow => c != null);
}

async function processCard(supabase: ReturnType<typeof dbAdmin>, card: CardRow) {
  const query = buildPrecisionQuery(card);
  if (!query.query) return { slug: card.slug, status: "no-query" as const };

  let scrape: { listings: unknown[] };
  try {
    scrape = await scrapeYahooJp(query.query, { mode: "closed", maxPages: 1 });
  } catch (err) {
    return {
      slug: card.slug,
      status: "scrape-failed" as const,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const result = selectMatched(scrape.listings, card, { minScore: MIN_MATCH_SCORE });
  const rawObs = result.priceObservations.find((o: { grade: string }) => o.grade === "RAW");
  if (!rawObs || rawObs.count < MIN_SAMPLE_COUNT) {
    return { slug: card.slug, status: "low-sample" as const, rawCount: rawObs?.count ?? 0 };
  }

  const yenMedian = rawObs.median;
  const usdMedian = Math.round(yenMedian * JPY_TO_USD * 100) / 100;
  const observedAt = new Date().toISOString();
  const { error } = await supabase
    .from("yahoo_jp_card_prices")
    .upsert(
      {
        canonical_slug: card.slug,
        grade: "RAW",
        price_usd: usdMedian,
        price_jpy: yenMedian,
        fx_rate_used: JPY_TO_USD,
        sample_count: rawObs.count,
        observed_at: observedAt,
        updated_at: observedAt,
      },
      { onConflict: "canonical_slug,grade" },
    );
  if (error) {
    return { slug: card.slug, status: "write-failed" as const, reason: error.message };
  }

  return {
    slug: card.slug,
    status: "ok" as const,
    yahoo_jp_price: usdMedian,
    yahoo_jp_price_jpy: yenMedian,
    rawCount: rawObs.count,
  };
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const deadline = startedAt + (maxDuration * 1000) - DEADLINE_RESERVE_MS;
  const url = new URL(req.url);
  const batchSize = Math.max(
    1,
    Math.min(100, Number.parseInt(url.searchParams.get("batch") ?? "", 10) || DEFAULT_BATCH_SIZE),
  );

  const supabase = dbAdmin();

  let cards: CardRow[];
  try {
    cards = await pickRefreshCandidates(supabase, batchSize);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), stage: "pick" },
      { status: 500 },
    );
  }

  if (cards.length === 0) {
    return NextResponse.json({
      ok: true,
      mode: "no-work",
      reason: `no JP cards stale (>${REFRESH_AFTER_HOURS}h) or unscraped`,
      elapsedMs: Date.now() - startedAt,
    });
  }

  let okCount = 0;
  let lowSampleCount = 0;
  let scrapeFailedCount = 0;
  let writeFailedCount = 0;
  let consecutiveScrapeFails = 0;
  let processed = 0;
  let haltReason: string | null = null;

  for (const card of cards) {
    if (Date.now() >= deadline) {
      haltReason = "deadline-reserve-reached";
      break;
    }
    if (consecutiveScrapeFails >= HALT_AFTER_CONSECUTIVE_SCRAPE_FAILS) {
      haltReason = `${consecutiveScrapeFails} consecutive scrape-failed responses — Yahoo! likely throttling`;
      break;
    }

    const result = await processCard(supabase, card);
    processed += 1;
    if (result.status === "ok") {
      okCount += 1;
      consecutiveScrapeFails = 0;
    } else if (result.status === "low-sample") {
      lowSampleCount += 1;
      consecutiveScrapeFails = 0;
    } else if (result.status === "scrape-failed") {
      scrapeFailedCount += 1;
      consecutiveScrapeFails += 1;
    } else if (result.status === "write-failed") {
      writeFailedCount += 1;
    }

    // Politeness inter-card delay (skipped on the last card)
    if (processed < cards.length && Date.now() + INTER_CARD_DELAY_MS < deadline) {
      await sleep(INTER_CARD_DELAY_MS);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  return NextResponse.json({
    ok: scrapeFailedCount === 0 || haltReason !== null,
    mode: haltReason ? "halted" : "processed",
    processed,
    candidatesAvailable: cards.length,
    written: okCount,
    lowSample: lowSampleCount,
    scrapeFailed: scrapeFailedCount,
    writeFailed: writeFailedCount,
    haltReason,
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
  });
}
