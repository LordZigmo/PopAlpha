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
const INTER_CARD_DELAY_MS = 4000;
// Yahoo's sold archive is sparse for long-tail JP cards. Store even a
// single matched RAW sale; consumers can use sample_count to decide
// whether to surface the price as high-confidence.
const MIN_SAMPLE_COUNT = 1;
const MIN_MATCH_SCORE = 0.5;
const REFRESH_AFTER_HOURS = 24 * 7; // 7 days — refresh cards older than this
const HALT_AFTER_CONSECUTIVE_SCRAPE_FAILS = 5; // tick exits early; next hour retries
const DEADLINE_RESERVE_MS = 30_000; // stop new cards if <30s left so the response can flush
const NONPRODUCTIVE_RETRY_HOURS = 24 * 7; // low-sample/no-query cards rotate out for a week
const TRANSIENT_RETRY_HOURS = 6; // scrape/write failures get a shorter cooldown
const CANDIDATE_SCAN_PAGE_SIZE = 1000;
const MAX_STALE_PRICE_SCAN_ROWS = 5000;
const MAX_INITIAL_FETCH_SCAN_ROWS = 25_000;
const YAHOO_ROUTE = "/api/cron/run-yahoo-jp-daily";
const BASE_CARD_SELECT = "slug,canonical_name,canonical_name_native,set_name,set_name_native,card_number,year,language";
const MATCHED_JP_CARD_SELECT = "slug,canonical_name,canonical_name_native,set_name,set_name_native,card_number,year,language,provider_card_map!inner(mapping_status)";

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

type YahooProcessResult =
  | { slug: string; status: "ok"; yahoo_jp_price: number; yahoo_jp_price_jpy: number; rawCount: number; rowsWritten: number; perPrintingRows: number }
  | { slug: string; status: "low-sample"; rawCount: number }
  | { slug: string; status: "scrape-failed"; reason: string }
  | { slug: string; status: "write-failed"; reason: string }
  | { slug: string; status: "no-query"; reason: string };

async function loadYahooScrapedSlugs(
  supabase: ReturnType<typeof dbAdmin>,
  slugs: string[],
): Promise<Set<string>> {
  const scraped = new Set<string>();
  const chunkSize = 100;

  for (let i = 0; i < slugs.length; i += chunkSize) {
    const chunk = slugs.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("yahoo_jp_card_prices")
      .select("canonical_slug")
      .eq("grade", "RAW")
      .in("canonical_slug", chunk);
    if (error) throw new Error(`yahoo_jp_card_prices(scraped slugs): ${error.message}`);

    for (const row of data ?? []) {
      if (row.canonical_slug) scraped.add(row.canonical_slug);
    }
  }

  return scraped;
}

async function loadYahooAttemptedSlugs(
  supabase: ReturnType<typeof dbAdmin>,
  slugs: string[],
): Promise<Set<string>> {
  const attempted = new Set<string>();
  const chunkSize = 100;

  for (let i = 0; i < slugs.length; i += chunkSize) {
    const chunk = slugs.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("jp_ingestion_attempts")
      .select("canonical_slug")
      .eq("provider", "YAHOO_JP")
      .in("canonical_slug", chunk);
    if (error) throw new Error(`jp_ingestion_attempts(yahoo attempted slugs): ${error.message}`);

    for (const row of data ?? []) {
      if (row.canonical_slug) attempted.add(row.canonical_slug);
    }
  }

  return attempted;
}

async function loadStaleYahooSlugs(
  supabase: ReturnType<typeof dbAdmin>,
  input: {
    cutoffIso: string;
    suppressedSlugs: Set<string>;
    limit: number;
  },
): Promise<string[]> {
  const staleSlugs: string[] = [];
  const seen = new Set<string>();

  for (
    let from = 0;
    staleSlugs.length < input.limit && from < MAX_STALE_PRICE_SCAN_ROWS;
    from += CANDIDATE_SCAN_PAGE_SIZE
  ) {
    const { data, error } = await supabase
      .from("yahoo_jp_card_prices")
      .select("canonical_slug,observed_at")
      .eq("grade", "RAW")
      .lt("observed_at", input.cutoffIso)
      .order("observed_at", { ascending: true, nullsFirst: true })
      .range(from, from + CANDIDATE_SCAN_PAGE_SIZE - 1);
    if (error) throw new Error(`stale-price scan: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      const slug = row.canonical_slug;
      if (!slug || seen.has(slug) || input.suppressedSlugs.has(slug)) continue;
      seen.add(slug);
      staleSlugs.push(slug);
      if (staleSlugs.length >= input.limit) break;
    }

    if (rows.length < CANDIDATE_SCAN_PAGE_SIZE) break;
  }

  return staleSlugs;
}

async function loadInitialYahooSlugs(
  supabase: ReturnType<typeof dbAdmin>,
  input: {
    suppressedSlugs: Set<string>;
    limit: number;
  },
): Promise<string[]> {
  const neverAttemptedSlugs: string[] = [];
  const retryNoPriceSlugs: string[] = [];
  const seen = new Set<string>();
  const candidatePoolSize = () => neverAttemptedSlugs.length + retryNoPriceSlugs.length;

  for (
    let from = 0;
    candidatePoolSize() < input.limit && from < MAX_INITIAL_FETCH_SCAN_ROWS;
    from += CANDIDATE_SCAN_PAGE_SIZE
  ) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select(MATCHED_JP_CARD_SELECT)
      .eq("language", "JP")
      .eq("provider_card_map.mapping_status", "MATCHED")
      .order("created_at", { ascending: false })
      .range(from, from + CANDIDATE_SCAN_PAGE_SIZE - 1);
    if (error) throw new Error(`matched-jp scan: ${error.message}`);

    const rows = (data ?? []) as CardRow[];
    const pageSlugs: string[] = [];
    for (const row of rows) {
      if (seen.has(row.slug) || input.suppressedSlugs.has(row.slug)) continue;
      seen.add(row.slug);
      pageSlugs.push(row.slug);
    }

    const [everScraped, everAttempted] = await Promise.all([
      loadYahooScrapedSlugs(supabase, pageSlugs),
      loadYahooAttemptedSlugs(supabase, pageSlugs),
    ]);
    for (const slug of pageSlugs) {
      if (everScraped.has(slug)) continue;
      if (everAttempted.has(slug)) {
        retryNoPriceSlugs.push(slug);
      } else {
        neverAttemptedSlugs.push(slug);
      }
      if (candidatePoolSize() >= input.limit) break;
    }

    if (rows.length < CANDIDATE_SCAN_PAGE_SIZE) break;
  }

  return [...neverAttemptedSlugs, ...retryNoPriceSlugs].slice(0, input.limit);
}

/**
 * Pick the N JP cards most in need of refresh. The query unions:
 *   • Cards with no yahoo_jp_card_prices row at all (NULL observed_at) —
 *     never been attempted, highest priority.
 *   • Cards with no price row but an older non-productive attempt —
 *     retried only after untouched cards have first pass coverage.
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

  const [staleSlugs, initialFetchSlugs] = await Promise.all([
    loadStaleYahooSlugs(supabase, {
      cutoffIso,
      suppressedSlugs,
      limit,
    }),
    loadInitialYahooSlugs(supabase, {
      suppressedSlugs,
      limit,
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

async function processCard(supabase: ReturnType<typeof dbAdmin>, card: CardRow): Promise<YahooProcessResult> {
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
  const rawObs = result.priceObservations.find((o: { grade: string }) => o.grade === "RAW");
  if (!rawObs || rawObs.count < MIN_SAMPLE_COUNT) {
    return { slug: card.slug, status: "low-sample" as const, rawCount: rawObs?.count ?? 0 };
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
    const obsUsd = Math.round(obsYen * JPY_TO_USD * 100) / 100;
    const { error } = await supabase
      .from("yahoo_jp_card_prices")
      .upsert(
        {
          canonical_slug: card.slug,
          printing_id: obs.printing_id,
          grade: "RAW",
          price_usd: obsUsd,
          price_jpy: obsYen,
          fx_rate_used: JPY_TO_USD,
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
    yahoo_jp_price: Math.round(rawObs.median * JPY_TO_USD * 100) / 100,
    yahoo_jp_price_jpy: rawObs.median,
    rawCount: rawObs.count,
    rowsWritten,
    perPrintingRows: writableObs.filter((o) => o.printing_id != null).length,
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
      reason: `no JP cards stale (>${REFRESH_AFTER_HOURS}h) or unscraped`,
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
      metadata: "perPrintingRows" in result
        ? { perPrintingRows: result.perPrintingRows, priceJpy: result.yahoo_jp_price_jpy }
        : {},
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
    haltReason,
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
  };
  console.info("[run-yahoo-jp-daily] summary", JSON.stringify(response));
  return NextResponse.json(response);
}
