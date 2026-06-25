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
import { getCurrencyToUsdRateAt } from "@/lib/pricing/fx";
import { scrapeYahooJp } from "@/scripts/scrape-yahoo-jp.mjs";
import { buildPrecisionQuery, selectMatched } from "@/lib/jp/matcher.mjs";
import {
  completeJpIngestionRun,
  createJpIngestionRun,
  loadRecentJpIngestionSuppression,
  recordJpIngestionAttempt,
  type JpIngestionRunCounters,
} from "@/lib/jp/ingestion-observability";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel hobby/pro tick ceiling

const DEFAULT_BATCH_SIZE = 50;
// Reserve most of each batch for stale-refresh (freshness) and cap
// initial-coverage (breadth). #163 made initial-coverage return a full
// batch of never-attempted slugs; left unbounded it consumed the whole budget
// and starved the stale-refresh path, so the 4k+ already-priced JP cards never
// re-scraped and their displayed prices went stale. This run is deadline-bound
// (halts at the ~270s reserve before clearing a 50-card batch), so capping
// initial keeps the stale-refresh slugs within reach of the deadline too.
// 0.6 -> 0.75 with the tier-cadence change: the hot tier's daily Yahoo
// refresh demand (~250 Yahoo-only hot cards/day + warm/sparse) needs ~38
// slots/tick; initial-coverage keeps ~12/tick (~288/day), which cycles the
// parked unpriced tail on roughly the same ~monthly cadence as its 30d
// NONPRODUCTIVE parking below.
const STALE_REFRESH_BUDGET_RATIO = 0.75;
const INTER_CARD_DELAY_MS = 4000;
// Yahoo's sold archive is sparse for long-tail JP cards. Store even a
// single matched RAW sale; consumers can use sample_count to decide
// whether to surface the price as high-confidence.
const MIN_SAMPLE_COUNT = 1;
const MIN_MATCH_SCORE = 0.5;
const HALT_AFTER_CONSECUTIVE_SCRAPE_FAILS = 5; // tick exits early; next hour retries
const DEADLINE_RESERVE_MS = 30_000; // stop new cards if <30s left so the response can flush
// Low-sample/no-query slugs rarely become productive week-over-week;
// re-probing them weekly burned the scarce initial-coverage slots that fund
// the hot tier's daily cadence. Park ~monthly — same tradeoff PR #209 made
// for Snkrdunk; still catches a card that later gains liquidity.
const NONPRODUCTIVE_RETRY_HOURS = 24 * 30;
const TRANSIENT_RETRY_HOURS = 6; // scrape/write failures get a shorter cooldown
const YAHOO_ROUTE = "/api/cron/run-yahoo-jp-daily";
const BASE_CARD_SELECT = "slug,canonical_name,canonical_name_native,set_name,set_name_native,card_number,year,language";

// JPY→USD is resolved live per run from the daily fx_rates series
// (getCurrencyToUsdRateAt, ingested by /api/cron/ingest-fx-rates) and
// threaded into processCard, so the converted column tracks the real
// exchange rate instead of a frozen ~¥147/$1 constant. getCurrencyToUsdRateAt
// falls back to the JPY_TO_USD_RATE env var / 0.0068 default when the
// fx_rates table has no JPYUSD row yet.

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

type YahooProcessResult =
  | { slug: string; status: "ok"; yahoo_jp_price: number; yahoo_jp_price_jpy: number; rawCount: number; rowsWritten: number; perPrintingRows: number; numberMismatchExcluded: number }
  | { slug: string; status: "low-sample"; rawCount: number; numberMismatchExcluded: number }
  | { slug: string; status: "scrape-failed"; reason: string }
  | { slug: string; status: "write-failed"; reason: string }
  | { slug: string; status: "no-query"; reason: string };

type YahooRefreshCandidateRow = {
  canonical_slug: string;
  observed_at: string | null;
  tier: string;
};

/**
 * Tier-cadence stale refresh: scan_yahoo_refresh_candidates replaces the old
 * flat-7d-cutoff paging loop. Per-tier cadence lives in the RPC (mirrored in
 * lib/jp/refresh-cadence.mjs): Yahoo-only hot 24h / Snkrdunk-covered hot 96h
 * (Snkrdunk owns that card's daily series) / warm 96h / sparse 288h /
 * dormant 720h / unknown 168h (= the old flat behavior, fail-open). Due rows
 * are ordered by overdue ratio ((now - observed_at) / cadence) so a capacity
 * shortfall drifts every tier proportionally instead of starving the tail.
 * Slug dedupe, suppression, and the limit all happen server-side.
 */
async function loadStaleYahooSlugs(
  supabase: ReturnType<typeof dbAdmin>,
  input: {
    suppressedSlugs: Set<string>;
    limit: number;
  },
): Promise<string[]> {
  const { data, error } = await supabase.rpc("scan_yahoo_refresh_candidates", {
    p_limit: input.limit,
    p_suppressed: [...input.suppressedSlugs],
  });
  if (error) throw new Error(`scan_yahoo_refresh_candidates: ${error.message}`);

  const rows = (data ?? []) as YahooRefreshCandidateRow[];
  return rows.map((row) => row.canonical_slug);
}

/**
 * Initial-coverage candidates: JP-language cards with no Yahoo! RAW price
 * row yet — every JP card gets one first-pass attempt (attempt-once-then-
 * park; misses are parked via the NONPRODUCTIVE/TRANSIENT suppression
 * below). Never-attempted (no YAHOO_JP jp_ingestion_attempts row) first:
 * cards with a MATCHED provider_card_map row (tier 1) ahead of unmapped
 * ones (tier 2), then attempted-but-still-no-price (tier 3), excluding the
 * suppressed slugs. The old MATCHED-mapping WHERE-gate was removed in
 * migration 20260613210000 (it permanently excluded 5,526 mostly-vintage
 * JP cards that the evidence says convert well); the mapping now only
 * orders tiers. The ordering, no-price exclusion, suppression filter, slug
 * dedupe, and limit all happen server-side in
 * scan_yahoo_initial_candidates so we no longer page the matched-JP
 * universe + load scraped/attempted membership Sets per page.
 *
 * Why an RPC (and not chained PostgREST embeds): applying `.eq`/`.is` to a
 * `!left`-embedded to-many relation makes PostgREST drop the left-join NULL
 * rows — which silently filtered out the never-attempted cards we most want,
 * degrading selection to a blind alphabetical head and freezing the rotation
 * for ~9 days (commit 1bdb948, reverted #162). The RPC uses a real
 * LEFT JOIN ... IS NULL so never-attempted rows are retained.
 */
async function loadInitialYahooSlugs(
  supabase: ReturnType<typeof dbAdmin>,
  input: {
    suppressedSlugs: Set<string>;
    limit: number;
  },
): Promise<string[]> {
  const { data, error } = await supabase.rpc("scan_yahoo_initial_candidates", {
    p_limit: input.limit,
    p_suppressed: [...input.suppressedSlugs],
  });
  if (error) throw new Error(`scan_yahoo_initial_candidates: ${error.message}`);

  const rows = (data ?? []) as Array<{ canonical_slug: string }>;
  return rows.map((row) => row.canonical_slug);
}

/**
 * Pick the N JP cards most in need of refresh:
 *   • Initial-coverage (capped share): unscraped matched cards via
 *     scan_yahoo_initial_candidates.
 *   • Tier-cadence refresh (the rest): priced cards past their
 *     jp_refresh_tier cadence via scan_yahoo_refresh_candidates,
 *     overdue-ratio ordered.
 */
async function pickRefreshCandidates(supabase: ReturnType<typeof dbAdmin>, limit: number): Promise<CardRow[]> {
  const nonproductiveCutoffIso = new Date(Date.now() - NONPRODUCTIVE_RETRY_HOURS * 60 * 60 * 1000).toISOString();
  const transientCutoffIso = new Date(Date.now() - TRANSIENT_RETRY_HOURS * 60 * 60 * 1000).toISOString();
  const [recentNonproductive, recentTransient] = await Promise.all([
    loadRecentJpIngestionSuppression(supabase, {
      provider: "YAHOO_JP",
      statuses: ["low-sample", "no-query"],
      sinceIso: nonproductiveCutoffIso,
    }),
    loadRecentJpIngestionSuppression(supabase, {
      provider: "YAHOO_JP",
      statuses: ["scrape-failed", "write-failed"],
      sinceIso: transientCutoffIso,
    }),
  ]);
  const suppressedSlugs = new Set([
    ...recentNonproductive.slugs,
    ...recentTransient.slugs,
  ]);

  // Cap initial-coverage so stale-refresh keeps a guaranteed share of the batch.
  const initialBudget = Math.max(1, limit - Math.ceil(limit * STALE_REFRESH_BUDGET_RATIO));
  const [staleSlugs, initialFetchSlugs] = await Promise.all([
    loadStaleYahooSlugs(supabase, {
      suppressedSlugs,
      limit,
    }),
    loadInitialYahooSlugs(supabase, {
      suppressedSlugs,
      limit: initialBudget,
    }),
  ]);

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
    .select(BASE_CARD_SELECT)
    .in("slug", orderedSlugs);
  if (cardsErr) throw new Error(`canonical_cards lookup: ${cardsErr.message}`);
  // Preserve the ordering we computed
  const cardsBySlug = new Map<string, CardRow>();
  for (const row of (cards ?? []) as CardRow[]) cardsBySlug.set(row.slug, row);
  return orderedSlugs.map((s) => cardsBySlug.get(s)).filter((c): c is CardRow => c != null);
}

async function processCard(supabase: ReturnType<typeof dbAdmin>, card: CardRow, jpyToUsd: number): Promise<YahooProcessResult> {
  const query = buildPrecisionQuery(card);
  if (!query.query) {
    return { slug: card.slug, status: "no-query", reason: "precision query empty" };
  }

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

  // Load printings so the matcher can split observations per finish.
  // Failure here is non-fatal — selectMatched falls back to legacy
  // single-observation-per-grade behavior when printings is empty.
  let printings: Array<{ id: string; finish: string | null }> = [];
  try {
    const { data: pData, error: pErr } = await supabase
      .from("card_printings")
      .select("id, finish")
      .eq("canonical_slug", card.slug);
    if (pErr) {
      console.warn(`[run-yahoo-jp-daily] card_printings lookup failed for ${card.slug}: ${pErr.message} (continuing without printing split)`);
    } else {
      printings = (pData ?? []) as typeof printings;
    }
  } catch (err) {
    console.warn(`[run-yahoo-jp-daily] card_printings lookup threw for ${card.slug}: ${err instanceof Error ? err.message : String(err)} (continuing without printing split)`);
  }

  const result = selectMatched(scrape.listings, card, {
    minScore: MIN_MATCH_SCORE,
    printings,
  });
  const numberMismatchExcluded: number = result.numberMismatchExcluded ?? 0;
  const rawObs = result.priceObservations.find((o: { grade: string }) => o.grade === "RAW");
  if (!rawObs || rawObs.count < MIN_SAMPLE_COUNT) {
    return { slug: card.slug, status: "low-sample" as const, rawCount: rawObs?.count ?? 0, numberMismatchExcluded };
  }

  const observedAt = new Date().toISOString();
  // Write every RAW observation that clears the sample threshold —
  // both per-printing rows (printing_id set) AND the canonical-level
  // rollup (printing_id null). The view JOINs both, falling back to
  // the canonical row when a specific printing has no per-printing
  // data yet.
  const writableObs = (result.priceObservations as Array<{
    grade: string;
    finish: string | null;
    printing_id: string | null;
    count: number;
    median: number;
  }>).filter((o) => o.grade === "RAW" && o.count >= MIN_SAMPLE_COUNT);

  let rowsWritten = 0;
  for (const obs of writableObs) {
    const obsYen = obs.median;
    const obsUsd = Math.round(obsYen * jpyToUsd * 100) / 100;
    const { error } = await supabase
      .from("yahoo_jp_card_prices")
      .upsert(
        {
          canonical_slug: card.slug,
          printing_id: obs.printing_id,
          grade: "RAW",
          price_usd: obsUsd,
          price_jpy: obsYen,
          fx_rate_used: jpyToUsd,
          sample_count: obs.count,
          observed_at: observedAt,
          updated_at: observedAt,
        },
        { onConflict: "canonical_slug,printing_id,grade" },
      );
    if (error) {
      return { slug: card.slug, status: "write-failed" as const, reason: error.message };
    }
    rowsWritten += 1;

    // Append the same observation to jp_card_price_history so
    // compute_jp_card_price_changes() (migration 20260520140000) can
    // derive 24h/7d deltas for the JP homepage rails. Mirrors the
    // pipeline-script writer in scripts/run-yahoo-jp-pipeline.mjs.
    // Failure here is non-fatal: the latest-price upsert above is the
    // source of truth for the homepage; the history append only
    // matters for delta math, and a missed row just means a slightly
    // staler baseline next tick.
    try {
      const { error: historyError } = await supabase
        .from("jp_card_price_history")
        .insert({
          canonical_slug: card.slug,
          printing_id: obs.printing_id,
          grade: "RAW",
          source: "yahoo_jp",
          price_jpy: obsYen,
          price_usd: obsUsd,
          sample_count: obs.count,
          observed_at: observedAt,
        });
      if (historyError) {
        console.warn(
          `[run-yahoo-jp-daily] jp_card_price_history append failed for ${card.slug}/${obs.printing_id ?? "canonical"}: ${historyError.message}`,
        );
      }
    } catch (err) {
      console.warn(
        `[run-yahoo-jp-daily] jp_card_price_history append threw for ${card.slug}/${obs.printing_id ?? "canonical"}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    slug: card.slug,
    status: "ok" as const,
    yahoo_jp_price: Math.round(rawObs.median * jpyToUsd * 100) / 100,
    yahoo_jp_price_jpy: rawObs.median,
    rawCount: rawObs.count,
    rowsWritten,
    perPrintingRows: writableObs.filter((o) => o.printing_id != null).length,
    numberMismatchExcluded,
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
  // Resolve the live JPY→USD rate once per run (freshest fx_rates row,
  // env/0.0068 fallback) and thread it through every conversion below.
  const { rate: jpyToUsd, fxSource: jpyFxSource } = await getCurrencyToUsdRateAt({
    supabase,
    currency: "JPY",
    asOf: null,
  });
  console.info(`[run-yahoo-jp-daily] JPY/USD ${jpyToUsd} (source=${jpyFxSource})`);
  const runId = await createJpIngestionRun(supabase, {
    provider: "YAHOO_JP",
    route: YAHOO_ROUTE,
    batchSize,
    startedAtIso: new Date(startedAt).toISOString(),
  });

  let cards: CardRow[];
  try {
    cards = await pickRefreshCandidates(supabase, batchSize);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const response = {
      ok: false,
      runId,
      error: err instanceof Error ? err.message : String(err),
      stage: "pick",
      elapsedMs,
    };
    await completeJpIngestionRun(supabase, runId, {
      status: "failed",
      mode: "failed",
      counters: {
        candidatesAvailable: 0,
        processed: 0,
        written: 0,
        lowSample: 0,
        scrapeFailed: 0,
        writeFailed: 0,
        noQuery: 0,
      },
      error: err instanceof Error ? err.message : String(err),
      elapsedMs,
    });
    console.error("[run-yahoo-jp-daily] summary", JSON.stringify(response));
    return NextResponse.json(response, { status: 500 });
  }

  if (cards.length === 0) {
    const elapsedMs = Date.now() - startedAt;
    const response = {
      ok: true,
      runId,
      mode: "no-work",
      reason: "no JP cards past tier cadence or unscraped",
      elapsedMs,
    };
    await completeJpIngestionRun(supabase, runId, {
      status: "succeeded",
      mode: "no-work",
      counters: {
        candidatesAvailable: 0,
        processed: 0,
        written: 0,
        lowSample: 0,
        scrapeFailed: 0,
        writeFailed: 0,
        noQuery: 0,
      },
      elapsedMs,
    });
    console.info("[run-yahoo-jp-daily] summary", JSON.stringify(response));
    return NextResponse.json(response);
  }

  let okCount = 0;
  let lowSampleCount = 0;
  let scrapeFailedCount = 0;
  let writeFailedCount = 0;
  let noQueryCount = 0;
  let numberMismatchExcludedTotal = 0;
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

    const attemptStartedAt = Date.now();
    const result = await processCard(supabase, card, jpyToUsd);
    processed += 1;
    if ("numberMismatchExcluded" in result) {
      numberMismatchExcludedTotal += result.numberMismatchExcluded;
    }
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
    } else if (result.status === "no-query") {
      noQueryCount += 1;
      consecutiveScrapeFails = 0;
    }
    await recordJpIngestionAttempt(supabase, {
      runId,
      provider: "YAHOO_JP",
      canonicalSlug: card.slug,
      status: result.status,
      rawCount: "rawCount" in result ? result.rawCount : null,
      rowsWritten: "rowsWritten" in result ? result.rowsWritten : 0,
      priceUsd: "yahoo_jp_price" in result ? result.yahoo_jp_price : null,
      sampleCount: "rawCount" in result ? result.rawCount : null,
      reason: "reason" in result ? result.reason : null,
      elapsedMs: Date.now() - attemptStartedAt,
      metadata: {
        ...("perPrintingRows" in result
          ? { perPrintingRows: result.perPrintingRows, priceJpy: result.yahoo_jp_price_jpy }
          : {}),
        ...("numberMismatchExcluded" in result && result.numberMismatchExcluded > 0
          ? { numberMismatchExcluded: result.numberMismatchExcluded }
          : {}),
      },
    });

    // Politeness inter-card delay (skipped on the last card)
    if (processed < cards.length && Date.now() + INTER_CARD_DELAY_MS < deadline) {
      await sleep(INTER_CARD_DELAY_MS);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const counters: JpIngestionRunCounters = {
    candidatesAvailable: cards.length,
    processed,
    written: okCount,
    lowSample: lowSampleCount,
    scrapeFailed: scrapeFailedCount,
    writeFailed: writeFailedCount,
    noQuery: noQueryCount,
  };
  await completeJpIngestionRun(supabase, runId, {
    status: "succeeded",
    mode: haltReason ? "halted" : "processed",
    counters,
    haltReason,
    elapsedMs,
  });
  const response = {
    ok: scrapeFailedCount === 0 || haltReason !== null,
    runId,
    mode: haltReason ? "halted" : "processed",
    processed,
    candidatesAvailable: cards.length,
    written: okCount,
    lowSample: lowSampleCount,
    scrapeFailed: scrapeFailedCount,
    writeFailed: writeFailedCount,
    noQuery: noQueryCount,
    numberMismatchExcluded: numberMismatchExcludedTotal,
    haltReason,
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
  };
  console.info("[run-yahoo-jp-daily] summary", JSON.stringify(response));
  return NextResponse.json(response);
}
