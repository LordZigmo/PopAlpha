/**
 * Cron: run-snkrdunk-daily
 *
 * Steady-state refresh of Snkrdunk scraped prices. Picks the N
 * oldest-observed_at rows already in snkrdunk_card_prices and re-fetches
 * each card via its persisted `snkrdunk_product_code` column, updating
 * the row with the latest median.
 *
 * Initial-fetch differs from Yahoo!: this cron only REFRESHES existing
 * rows. Adding a new card requires running scripts/run-snkrdunk-pipeline.mjs
 * (or the future automated catalog mapper) which sets up the
 * (canonical_slug, snkrdunk_product_code) mapping. The cron then keeps
 * those rows fresh on the cadence below.
 *
 * Schedule: NOT yet scheduled in vercel.json. We're at the 40-cron Vercel
 * Pro quota cap (see PR #42's consolidation work) — adding one more
 * entry pushes us over quota, where Vercel silently throttles to ~daily.
 * For v0 the route is registered + invokable manually; once a slot opens
 * (further consolidation or quota bump), schedule hourly: "26 * * * *"
 * matching run-yahoo-jp-daily's offset.
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
import { scrapeSnkrdunk, SnkrdunkPushbackError } from "@/scripts/scrape-snkrdunk.mjs";
import { aggregateSnkrdunkListings } from "@/lib/jp/snkrdunk-matcher.mjs";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel pro tick ceiling

const DEFAULT_BATCH_SIZE = 30; // smaller than yahoo (50) — robots.txt softness
const INTER_CARD_DELAY_MS = 4000;
const MIN_SAMPLE_COUNT = 3;
const REFRESH_AFTER_HOURS = 24 * 7; // 7 days
const DEADLINE_RESERVE_MS = 30_000;
const SCRAPE_PAGES = 4; // most cards have ≤2 pages; 4 is safe upper bound

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RefreshCandidate = {
  canonical_slug: string;
  printing_id: string | null;
  snkrdunk_product_code: string;
  observed_at: string | null;
};

/**
 * Pick the N Snkrdunk-tracked cards most in need of refresh: existing
 * snkrdunk_card_prices rows whose observed_at is null OR older than
 * REFRESH_AFTER_HOURS. Group by (canonical_slug, snkrdunk_product_code)
 * so we re-fetch each Snkrdunk product at most once per tick even if it
 * has multiple grade rows.
 */
async function pickRefreshCandidates(
  supabase: ReturnType<typeof dbAdmin>,
  limit: number,
): Promise<RefreshCandidate[]> {
  const cutoffIso = new Date(Date.now() - REFRESH_AFTER_HOURS * 60 * 60 * 1000).toISOString();

  // Fetch stale rows ordered by observed_at ASC (oldest first, NULLs first).
  // Pull more than `limit` because we'll deduplicate by product code.
  const { data, error } = await supabase
    .from("snkrdunk_card_prices")
    .select("canonical_slug, printing_id, snkrdunk_product_code, observed_at")
    .or(`observed_at.is.null,observed_at.lt.${cutoffIso}`)
    .not("snkrdunk_product_code", "is", null)
    .order("observed_at", { ascending: true, nullsFirst: true })
    .limit(limit * 3);
  if (error) throw new Error(`stale-snkrdunk scan: ${error.message}`);

  const rows = (data ?? []) as RefreshCandidate[];

  // Dedupe by snkrdunk_product_code (one re-fetch covers all grade rows
  // for that product). Keep the canonical-level (printing_id NULL) row
  // when both exist so the scrape result populates the rollup row first.
  const byProduct = new Map<string, RefreshCandidate>();
  for (const row of rows) {
    if (!row.snkrdunk_product_code) continue;
    const existing = byProduct.get(row.snkrdunk_product_code);
    if (!existing) {
      byProduct.set(row.snkrdunk_product_code, row);
    } else if (existing.printing_id != null && row.printing_id == null) {
      // Prefer the canonical-level row as the "primary" candidate
      byProduct.set(row.snkrdunk_product_code, row);
    }
  }

  return [...byProduct.values()].slice(0, limit);
}

async function processCard(
  supabase: ReturnType<typeof dbAdmin>,
  candidate: RefreshCandidate,
): Promise<
  | { slug: string; status: "ok"; rowsWritten: number; price: number | null; sampleCount: number }
  | { slug: string; status: "low-sample"; rawCount: number }
  | { slug: string; status: "scrape-failed"; reason: string }
  | { slug: string; status: "write-failed"; reason: string }
> {
  const { canonical_slug: slug, snkrdunk_product_code: productCode } = candidate;
  const tradingCardId = productCode.startsWith("SW---") ? productCode.slice("SW---".length) : productCode;

  // Resolve printing_id at scrape-time: re-read from card_printings so
  // a single-printing card gets attributed correctly even if the row was
  // originally written with printing_id NULL (pre-catalog-mapper era).
  // We DON'T let a failure here abort the card — printing_id NULL is a
  // valid fallback. But we DO log the error so a DB outage doesn't
  // silently degrade every card to canonical-only without a trace.
  let printingId: string | null = null;
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
    (o: { count: number }) => o.count >= MIN_SAMPLE_COUNT,
  );
  if (writableObs.length === 0) {
    const rawObs = agg.priceObservations.find((o: { grade: string }) => o.grade === "RAW");
    return { slug, status: "low-sample", rawCount: rawObs?.count ?? 0 };
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
    const { error } = await supabase.from("snkrdunk_card_prices").upsert(
      {
        canonical_slug: slug,
        printing_id: obs.printing_id,
        grade: obs.grade,
        price_usd: obs.median,
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
  }

  const summaryObs =
    writableObs.find((o: { grade: string; printing_id: string | null }) =>
      o.grade === "RAW" && o.printing_id === null,
    ) ??
    writableObs.find((o: { grade: string }) => o.grade === "RAW") ??
    writableObs[0];
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

  let candidates: RefreshCandidate[];
  try {
    candidates = await pickRefreshCandidates(supabase, batchSize);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        stage: "pick",
      },
      { status: 500 },
    );
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      mode: "no-work",
      reason: `no snkrdunk_card_prices rows stale (>${REFRESH_AFTER_HOURS}h)`,
      elapsedMs: Date.now() - startedAt,
    });
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
    try {
      result = await processCard(supabase, candidate);
    } catch (err) {
      if (err instanceof SnkrdunkPushbackError) {
        haltReason = `snkrdunk-pushback: ${err.message}`;
        break;
      }
      throw err;
    }

    processed += 1;
    if (result.status === "ok") okCount += 1;
    else if (result.status === "low-sample") lowSampleCount += 1;
    else if (result.status === "scrape-failed") scrapeFailedCount += 1;
    else if (result.status === "write-failed") writeFailedCount += 1;

    if (processed < candidates.length && Date.now() + INTER_CARD_DELAY_MS < deadline) {
      await sleep(INTER_CARD_DELAY_MS);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  return NextResponse.json({
    ok: scrapeFailedCount === 0 || haltReason !== null,
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
  });
}
