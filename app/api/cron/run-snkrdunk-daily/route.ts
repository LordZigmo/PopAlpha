/**
 * Cron: run-snkrdunk-daily
 *
 * Steady-state refresh of Snkrdunk scraped prices. Picks mapped
 * Snkrdunk products that do not have a price row yet first, then the N
 * oldest-observed_at rows already in snkrdunk_card_prices and re-fetches
 * each card via its persisted `snkrdunk_product_code` column.
 *
 * Initial-fetch differs from Yahoo!: first-time coverage depends on
 * snkrdunk_product_map. The matcher/mapper owns the risky catalog
 * decision; this cron only ingests rows already marked MATCHED.
 *
 * Schedule: hourly (configured in vercel.json).
 *
 * Conservative batch size since Snkrdunk's robots.txt asks us not to
 * crawl /en/v1/ — keeping each tick small reduces the spirit-of-the-norm
 * violation surface.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 *
 * Politeness:
 *   • 4s inter-card delay
 *   • Sequential (concurrency=1)
 *   • SnkrdunkPushbackError (429/403/503) halts the tick immediately —
 *     next hour's tick retries with no state to clean up since the
 *     snkrdunk_card_prices upsert is idempotent on (canonical_slug,
 *     printing_id, grade).
 *
 * Health: returns a stats payload the operator can grep for in Vercel
 * cron logs. Same shape as run-yahoo-jp-daily for consistency.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { getCurrencyToUsdRateAt } from "@/lib/pricing/fx";
import { scrapeSnkrdunk, SnkrdunkPushbackError } from "@/scripts/scrape-snkrdunk.mjs";
import { aggregateSnkrdunkListings } from "@/lib/jp/snkrdunk-matcher.mjs";
import {
  completeJpIngestionRun,
  createJpIngestionRun,
  loadRecentJpIngestionSuppression,
  recordJpIngestionAttempt,
  type JpIngestionRunCounters,
} from "@/lib/jp/ingestion-observability";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel pro tick ceiling

const DEFAULT_BATCH_SIZE = 50; // raised from 30 to use idle deadline headroom (batches of 30 finished in ~130s of the 300s budget). Per-card delay is unchanged, so robots.txt politeness is preserved and the deadline guard still halts gracefully.
// Reserve ~60% of each batch for stale-refresh (freshness) and cap
// initial-coverage at ~40% (breadth). #163 made initial-coverage return a full
// batch of never-attempted products; seeded first into byProduct it consumed
// the whole budget and skipped the stale-refresh scan, so the 4k+ already-priced
// JP cards never re-scraped and their displayed prices went stale.
const STALE_REFRESH_BUDGET_RATIO = 0.6;
const INTER_CARD_DELAY_MS = 4000;

// Mirror of scripts/run-snkrdunk-pipeline.mjs — derive price_jpy at write
// time so the JPY value stamped on each row matches the FX rate at
// observation time. Without this, the cron path would only write
// price_usd, leaving price_jpy at the migration-backfilled value
// indefinitely (or NULL on newly inserted per-printing rows). Codex P2
// on PR #94. Phase C-1b 2026-05-16.
//
// The JPY→USD rate is resolved live per run from the daily fx_rates series
// (getCurrencyToUsdRateAt, ingested by /api/cron/ingest-fx-rates) and
// threaded into processCard, instead of a frozen ~¥147/$1 constant.
// getCurrencyToUsdRateAt falls back to the JPY_TO_USD_RATE env var / 0.0068
// default when fx_rates has no JPYUSD row yet.
// Write/park split (option E of the JP display-policy design, 2026-06-12).
// Formerly a single MIN_SAMPLE_COUNT = 3 that gated the WRITE: a scrape
// returning 1-2 sold samples per grade wrote nothing — the observation
// was destroyed at scrape time. The split decouples the two decisions:
//
// MIN_WRITE_SAMPLE_COUNT (write gate): any grade bucket with >= 1 sold
// sample is persisted to snkrdunk_card_prices and appended to
// jp_card_price_history with its TRUE sample_count. Mirrors
// run-yahoo-jp-daily, which has always written from sample_count=1 on
// the principle that consumers decide trust via sample_count. Low-sample
// rows do NOT display: refresh_jp_price_display floors at
// sample_count >= 3 (migration 20260613150000), and
// compute_jp_card_price_changes gains the same floor in migration
// 20260614120000_compute_jp_changes_sample_floor.sql shipped alongside
// this split.
const MIN_WRITE_SAMPLE_COUNT = 1;
// MIN_PRODUCTIVE_SAMPLE_COUNT (status/parking gate): unchanged "why 3"
// reasoning — a scrape where no grade bucket reaches 3 sold samples
// rarely yields a DISPLAYABLE price, so it still classifies as
// "low-sample" and parks for NONPRODUCTIVE_RETRY_HOURS. Keeps the
// PR #209 capacity protection byte-identical.
const MIN_PRODUCTIVE_SAMPLE_COUNT = 3;
const DEADLINE_RESERVE_MS = 30_000;
const SCRAPE_PAGES = 4; // most cards have ≤2 pages; 4 is safe upper bound
// Low-sample codes (Snkrdunk returns listings but < MIN_PRODUCTIVE_SAMPLE_COUNT
// sold per grade) never yield a displayable price, so re-probing them weekly
// just burns the scarce initial-coverage slots. ~2,804 matched codes are
// low-sample vs ~2,853 never scraped (2026-06-08) — re-admitting the former
// every 7d starved the latter. Park ~monthly: still catches a card that
// later gains liquidity.
const NONPRODUCTIVE_RETRY_HOURS = 24 * 30;
const TRANSIENT_RETRY_HOURS = 6;
const SNKRDUNK_ROUTE = "/api/cron/run-snkrdunk-daily";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RefreshCandidate = {
  canonical_slug: string;
  printing_id: string | null;
  snkrdunk_product_code: string;
  observed_at: string | null;
};

type SnkrdunkInitialCandidateRow = {
  canonical_slug: string;
  snkrdunk_product_code: string;
  tier: number;
};

type SnkrdunkRefreshCandidateRow = {
  canonical_slug: string;
  printing_id: string | null;
  snkrdunk_product_code: string;
  observed_at: string | null;
  tier: string;
};

type SnkrdunkProcessResult =
  | { slug: string; status: "ok"; rowsWritten: number; price: number | null; sampleCount: number }
  // low-sample can still WRITE rows (1-2-sample observations persist with
  // their true sample_count; the >= 3 floor lives downstream in the display
  // refresher). status stays "low-sample" so parking semantics are unchanged.
  | { slug: string; status: "low-sample"; rawCount: number; rowsWritten: number }
  | { slug: string; status: "scrape-failed"; reason: string }
  | { slug: string; status: "write-failed"; reason: string };

/**
 * Initial-coverage candidates: MATCHED Snkrdunk products that have no price
 * row yet, never-attempted (no SNKRDUNK jp_ingestion_attempts row for the
 * product code) first (tier 1), then attempted-but-still-no-price (tier 2),
 * excluding the suppressed source keys. The ordering, no-price exclusion,
 * suppression filter, product-code dedupe, and limit all happen server-side
 * in scan_snkrdunk_initial_candidates so we no longer page the full map +
 * load priced/attempted membership Sets per page.
 *
 * Why an RPC (and not chained PostgREST embeds): applying `.eq`/`.is` to a
 * `!left`-embedded to-many relation makes PostgREST drop the left-join NULL
 * rows — which silently filtered out the never-attempted products we most
 * want, degrading selection to a blind alphabetical head and freezing the
 * rotation for ~9 days (commit 1bdb948, reverted #162). The RPC uses a real
 * LEFT JOIN ... IS NULL so never-attempted rows are retained.
 */
async function loadInitialSnkrdunkCandidates(
  supabase: ReturnType<typeof dbAdmin>,
  input: {
    suppressedSourceKeys: Set<string>;
    limit: number;
  },
): Promise<RefreshCandidate[]> {
  const { data, error } = await supabase.rpc("scan_snkrdunk_initial_candidates", {
    p_limit: input.limit,
    p_suppressed: [...input.suppressedSourceKeys],
  });
  if (error) throw new Error(`scan_snkrdunk_initial_candidates: ${error.message}`);

  const rows = (data ?? []) as SnkrdunkInitialCandidateRow[];
  return rows.map((row) => ({
    canonical_slug: row.canonical_slug,
    printing_id: null,
    snkrdunk_product_code: row.snkrdunk_product_code,
    observed_at: null,
  }));
}

/**
 * Pick the N Snkrdunk-tracked cards most in need of refresh: mapped
 * products with no successful price row first (initial-coverage, capped
 * share), then priced products past their jp_refresh_tier cadence via
 * scan_snkrdunk_refresh_candidates (overdue-ratio ordered).
 */
async function pickRefreshCandidates(
  supabase: ReturnType<typeof dbAdmin>,
  limit: number,
): Promise<RefreshCandidate[]> {
  const nonproductiveCutoffIso = new Date(Date.now() - NONPRODUCTIVE_RETRY_HOURS * 60 * 60 * 1000).toISOString();
  const transientCutoffIso = new Date(Date.now() - TRANSIENT_RETRY_HOURS * 60 * 60 * 1000).toISOString();
  const [recentNonproductive, recentTransient] = await Promise.all([
    loadRecentJpIngestionSuppression(supabase, {
      provider: "SNKRDUNK",
      statuses: ["low-sample"],
      sinceIso: nonproductiveCutoffIso,
    }),
    loadRecentJpIngestionSuppression(supabase, {
      provider: "SNKRDUNK",
      statuses: ["scrape-failed", "write-failed"],
      sinceIso: transientCutoffIso,
    }),
  ]);
  const suppressedSourceKeys = new Set([
    ...recentNonproductive.sourceKeys,
    ...recentTransient.sourceKeys,
  ]);

  // Cap initial-coverage so the stale-refresh scan below keeps its budget share.
  const initialBudget = Math.max(1, limit - Math.ceil(limit * STALE_REFRESH_BUDGET_RATIO));
  const initialCandidates = await loadInitialSnkrdunkCandidates(supabase, {
    suppressedSourceKeys,
    limit: initialBudget,
  });

  const byProduct = new Map<string, RefreshCandidate>();
  for (const candidate of initialCandidates) {
    byProduct.set(candidate.snkrdunk_product_code, candidate);
  }

  // Tier-cadence stale refresh: scan_snkrdunk_refresh_candidates replaces the
  // old flat-7d-cutoff paging loop. Per-tier cadence lives in the RPC
  // (mirrored in lib/jp/refresh-cadence.mjs): hot 24h / warm 72h /
  // sparse+unknown 168h (= the old flat behavior, fail-open) / dormant 720h,
  // with due rows ordered by overdue ratio ((now - observed_at) / cadence) so
  // a capacity shortfall drifts every tier proportionally instead of starving
  // the tail. The dedupe-by-product-code with the PER-PRINTING row preferred
  // (Codex P2 on PR #50: the per-printing candidate refreshes both the
  // per-printing and canonical rows in one pass; the canonical candidate
  // strands the per-printing row stale) also lives in the RPC. Initial
  // candidates can't collide with refresh candidates (no price row vs price
  // row), but keep the has-check so initial-coverage always wins a slot.
  const refreshBudget = Math.max(0, limit - byProduct.size);
  if (refreshBudget > 0) {
    const { data, error } = await supabase.rpc("scan_snkrdunk_refresh_candidates", {
      p_limit: refreshBudget,
      p_suppressed: [...suppressedSourceKeys],
    });
    if (error) throw new Error(`scan_snkrdunk_refresh_candidates: ${error.message}`);

    const rows = (data ?? []) as SnkrdunkRefreshCandidateRow[];
    for (const row of rows) {
      if (!row.snkrdunk_product_code) continue;
      if (byProduct.has(row.snkrdunk_product_code)) continue;
      byProduct.set(row.snkrdunk_product_code, {
        canonical_slug: row.canonical_slug,
        printing_id: row.printing_id,
        snkrdunk_product_code: row.snkrdunk_product_code,
        observed_at: row.observed_at,
      });
    }
  }

  return [...byProduct.values()].slice(0, limit);
}

async function processCard(
  supabase: ReturnType<typeof dbAdmin>,
  candidate: RefreshCandidate,
  jpyToUsd: number,
): Promise<
  SnkrdunkProcessResult
> {
  const { canonical_slug: slug, snkrdunk_product_code: productCode } = candidate;
  const tradingCardId = productCode.startsWith("SW---") ? productCode.slice("SW---".length) : productCode;

  // Resolve printing_id at scrape-time. Priority order:
  //   1. If the stale row we picked already has a printing_id (e.g. a
  //      catalog mapper or manual seed picked one for this Snkrdunk
  //      product), preserve it. Without this, a multi-printing card's
  //      per-printing row gets discarded every refresh and we only
  //      write the canonical (null) row — the stale per-printing row
  //      is then re-selected next tick and the view keeps serving
  //      stale per-printing data. Codex P2 on PR #49.
  //   2. Otherwise, fall back to the single-printing lookup so a card
  //      with exactly one printing gets the correct printing_id even
  //      if the row was originally written with printing_id NULL
  //      (pre-catalog-mapper era).
  //   3. Otherwise stay at null (canonical-level rollup only — valid
  //      fallback for multi-printing cards without a catalog mapping).
  //
  // Lookup failures are logged but never abort the card.
  let printingId: string | null = candidate.printing_id ?? null;
  if (printingId == null) {
    try {
      const { data: printings, error: printingsErr } = await supabase
        .from("card_printings")
        .select("id")
        .eq("canonical_slug", slug);
      if (printingsErr) {
        console.warn(`[run-snkrdunk-daily] card_printings lookup failed for ${slug}: ${printingsErr.message} (continuing with printing_id=null)`);
      } else if (printings && printings.length === 1) {
        printingId = printings[0].id;
      }
    } catch (err) {
      console.warn(`[run-snkrdunk-daily] card_printings lookup threw for ${slug}: ${err instanceof Error ? err.message : String(err)} (continuing with printing_id=null)`);
    }
  }

  // Scrape — SnkrdunkPushbackError propagates so the caller halts the tick
  let scrape: Awaited<ReturnType<typeof scrapeSnkrdunk>>;
  try {
    scrape = await scrapeSnkrdunk(tradingCardId, { maxPages: SCRAPE_PAGES });
  } catch (err) {
    if (err instanceof SnkrdunkPushbackError) throw err;
    return {
      slug,
      status: "scrape-failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const agg = aggregateSnkrdunkListings(scrape.listings, {
    canonicalSlug: slug,
    printingId,
  });
  const writableObs = agg.priceObservations.filter(
    (o: { count: number }) => o.count >= MIN_WRITE_SAMPLE_COUNT,
  );
  const productiveObs = writableObs.filter(
    (o: { count: number }) => o.count >= MIN_PRODUCTIVE_SAMPLE_COUNT,
  );
  const rawObs = agg.priceObservations.find((o: { grade: string }) => o.grade === "RAW");
  if (writableObs.length === 0) {
    // Zero sold samples in every grade — nothing to persist. Classification
    // and parking identical to the pre-split behavior.
    return { slug, status: "low-sample", rawCount: rawObs?.count ?? 0, rowsWritten: 0 };
  }

  const observedAt = new Date().toISOString();
  let rowsWritten = 0;
  for (const obs of writableObs as Array<{
    grade: string;
    printing_id: string | null;
    count: number;
    median: number;
    currency: string | null;
  }>) {
    const priceUsd = obs.median;
    // Derive JPY at write time from the same env-driven rate the pipeline
    // uses. Skip when price is missing/non-positive so the row's JPY
    // doesn't carry a misleading value. See JPY_TO_USD constant above.
    const priceJpy = typeof priceUsd === "number" && Number.isFinite(priceUsd) && priceUsd > 0
      ? Math.round(priceUsd / jpyToUsd)
      : null;
    const { error } = await supabase.from("snkrdunk_card_prices").upsert(
      {
        canonical_slug: slug,
        printing_id: obs.printing_id,
        grade: obs.grade,
        price_usd: priceUsd,
        price_jpy: priceJpy,
        fx_rate_used: priceJpy != null ? jpyToUsd : null,
        currency: obs.currency ?? "USD",
        sample_count: obs.count,
        snkrdunk_product_code: productCode,
        observed_at: observedAt,
        updated_at: observedAt,
      },
      { onConflict: "canonical_slug,printing_id,grade" },
    );
    if (error) return { slug, status: "write-failed", reason: error.message };
    rowsWritten += 1;

    // Append the same observation to jp_card_price_history so
    // compute_jp_card_price_changes() (migration 20260520140000) can
    // derive 24h/7d deltas for the JP homepage rails. 1-2-sample rows
    // append too (the tiered-display work needs the history) but are
    // excluded from the delta math by the sample_count >= 3 floor in
    // migration 20260614120000. Mirrors the pipeline-script writer in
    // scripts/run-snkrdunk-pipeline.mjs.
    // Non-fatal — the latest-price upsert above is the homepage's
    // source of truth; a missed history row just means a slightly
    // staler baseline next tick.
    try {
      const { error: historyError } = await supabase
        .from("jp_card_price_history")
        .insert({
          canonical_slug: slug,
          printing_id: obs.printing_id,
          grade: obs.grade,
          source: "snkrdunk",
          price_jpy: priceJpy,
          price_usd: priceUsd,
          sample_count: obs.count,
          observed_at: observedAt,
        });
      if (historyError) {
        console.warn(
          `[run-snkrdunk-daily] jp_card_price_history append failed for ${slug}/${obs.printing_id ?? "canonical"}: ${historyError.message}`,
        );
      }
    } catch (err) {
      console.warn(
        `[run-snkrdunk-daily] jp_card_price_history append threw for ${slug}/${obs.printing_id ?? "canonical"}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Status/parking gate, decoupled from the write gate: the 1-2-sample rows
  // were persisted above (write happens FIRST now — option E reorder), but a
  // scrape where NO grade reached MIN_PRODUCTIVE_SAMPLE_COUNT still reports
  // "low-sample", so the NONPRODUCTIVE_RETRY_HOURS parking, the suppression
  // scan in pickRefreshCandidates, and the jp_ingestion_runs lowSample
  // counter are all byte-identical to the pre-split behavior (PR #209
  // capacity protection).
  if (productiveObs.length === 0) {
    return { slug, status: "low-sample", rawCount: rawObs?.count ?? 0, rowsWritten };
  }

  // Summary picked from PRODUCTIVE observations only, so an ok-status
  // attempt row keeps surfacing a price that met the >= 3 floor — a
  // 1-sample RAW row must not become the attempt's headline price just
  // because it now gets written.
  const summaryObs =
    productiveObs.find((o: { grade: string; printing_id: string | null }) =>
      o.grade === "RAW" && o.printing_id === null,
    ) ??
    productiveObs.find((o: { grade: string }) => o.grade === "RAW") ??
    productiveObs[0];
  return {
    slug,
    status: "ok",
    rowsWritten,
    price: summaryObs?.median ?? null,
    sampleCount: summaryObs?.count ?? 0,
  };
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const deadline = startedAt + maxDuration * 1000 - DEADLINE_RESERVE_MS;
  const url = new URL(req.url);
  const batchSize = Math.max(
    1,
    Math.min(100, Number.parseInt(url.searchParams.get("batch") ?? "", 10) || DEFAULT_BATCH_SIZE),
  );

  const supabase = dbAdmin();
  // Resolve the live JPY→USD rate once per run (freshest fx_rates row,
  // env/0.0068 fallback) for the price_jpy back-conversion below.
  const { rate: jpyToUsd, fxSource: jpyFxSource } = await getCurrencyToUsdRateAt({
    supabase,
    currency: "JPY",
    asOf: null,
  });
  console.info(`[run-snkrdunk-daily] JPY/USD ${jpyToUsd} (source=${jpyFxSource})`);
  const runId = await createJpIngestionRun(supabase, {
    provider: "SNKRDUNK",
    route: SNKRDUNK_ROUTE,
    batchSize,
    startedAtIso: new Date(startedAt).toISOString(),
  });

  let candidates: RefreshCandidate[];
  try {
    candidates = await pickRefreshCandidates(supabase, batchSize);
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
    console.error("[run-snkrdunk-daily] summary", JSON.stringify(response));
    return NextResponse.json(response, { status: 500 });
  }

  if (candidates.length === 0) {
    const elapsedMs = Date.now() - startedAt;
    const response = {
      ok: true,
      runId,
      mode: "no-work",
      reason: "no snkrdunk_card_prices rows past tier cadence",
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
    console.info("[run-snkrdunk-daily] summary", JSON.stringify(response));
    return NextResponse.json(response);
  }

  let okCount = 0;
  let lowSampleCount = 0;
  let scrapeFailedCount = 0;
  let writeFailedCount = 0;
  let processed = 0;
  let haltReason: string | null = null;

  for (const candidate of candidates) {
    if (Date.now() >= deadline) {
      haltReason = "deadline-reserve-reached";
      break;
    }

    let result: Awaited<ReturnType<typeof processCard>>;
    const attemptStartedAt = Date.now();
    try {
      result = await processCard(supabase, candidate, jpyToUsd);
    } catch (err) {
      if (err instanceof SnkrdunkPushbackError) {
        haltReason = `snkrdunk-pushback: ${err.message}`;
        processed += 1;
        scrapeFailedCount += 1;
        await recordJpIngestionAttempt(supabase, {
          runId,
          provider: "SNKRDUNK",
          canonicalSlug: candidate.canonical_slug,
          sourceKey: candidate.snkrdunk_product_code,
          printingId: candidate.printing_id,
          status: "scrape-failed",
          reason: haltReason,
          elapsedMs: Date.now() - attemptStartedAt,
        });
        break;
      }
      const elapsedMs = Date.now() - startedAt;
      await completeJpIngestionRun(supabase, runId, {
        status: "failed",
        mode: "failed",
        counters: {
          candidatesAvailable: candidates.length,
          processed,
          written: okCount,
          lowSample: lowSampleCount,
          scrapeFailed: scrapeFailedCount,
          writeFailed: writeFailedCount,
          noQuery: 0,
        },
        error: err instanceof Error ? err.message : String(err),
        elapsedMs,
      });
      throw err;
    }

    processed += 1;
    if (result.status === "ok") okCount += 1;
    else if (result.status === "low-sample") lowSampleCount += 1;
    else if (result.status === "scrape-failed") scrapeFailedCount += 1;
    else if (result.status === "write-failed") writeFailedCount += 1;
    await recordJpIngestionAttempt(supabase, {
      runId,
      provider: "SNKRDUNK",
      canonicalSlug: candidate.canonical_slug,
      sourceKey: candidate.snkrdunk_product_code,
      printingId: candidate.printing_id,
      status: result.status,
      rawCount: "rawCount" in result ? result.rawCount : null,
      rowsWritten: "rowsWritten" in result ? result.rowsWritten : 0,
      priceUsd: "price" in result ? result.price : null,
      sampleCount: "sampleCount" in result ? result.sampleCount : "rawCount" in result ? result.rawCount : null,
      reason: "reason" in result ? result.reason : null,
      elapsedMs: Date.now() - attemptStartedAt,
    });

    if (processed < candidates.length && Date.now() + INTER_CARD_DELAY_MS < deadline) {
      await sleep(INTER_CARD_DELAY_MS);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const counters: JpIngestionRunCounters = {
    candidatesAvailable: candidates.length,
    processed,
    written: okCount,
    lowSample: lowSampleCount,
    scrapeFailed: scrapeFailedCount,
    writeFailed: writeFailedCount,
    noQuery: 0,
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
    candidatesAvailable: candidates.length,
    written: okCount,
    lowSample: lowSampleCount,
    scrapeFailed: scrapeFailedCount,
    writeFailed: writeFailedCount,
    haltReason,
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
  };
  console.info("[run-snkrdunk-daily] summary", JSON.stringify(response));
  return NextResponse.json(response);
}
