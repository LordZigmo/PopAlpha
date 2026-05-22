#!/usr/bin/env node
/**
 * Yahoo! Auctions JP — production pipeline runner.
 *
 * Takes a list of canonical_slugs (or a set_code, or --random-jp=N),
 * runs the scraper + matcher on each, and upserts the median raw price
 * into the dedicated yahoo_jp_card_prices table (keyed on
 * canonical_slug + grade). The public_card_metrics view JOINs that
 * table to expose yahoo_jp_* columns to iOS — see migration
 * 20260508140000 for the architectural decision to keep this data
 * out of card_metrics (its lifecycle is independent of the SCRYDEX
 * GC that runs on card_metrics).
 *
 * This is the production version of scripts/match-yahoo-jp.mjs — the
 * latter is a per-card debugging CLI; this runs in batch and persists.
 *
 * Architectural note — why we bypass the raw/normalized/matched
 * pipeline:
 *   The existing SCRYDEX flow goes raw_payloads → normalized
 *   observations → provider_card_map matches → variant_metrics →
 *   card_metrics rollup. That architecture assumes provider IDs
 *   (Scrydex card.id) that stably map to canonical_slug via
 *   provider_card_map. YAHOO_JP doesn't have those — listings have
 *   auctionIds that are unique-per-listing, not per-physical-card.
 *   Matching is structural (title parsing + glossary + scoring,
 *   per lib/jp/matcher.mjs) rather than ID-keyed. Forcing this through
 *   the existing pipeline would require either fake provider IDs or a
 *   parallel matcher that essentially duplicates lib/jp/matcher.mjs.
 *   Direct write to card_metrics is the minimal-overhead path.
 *
 * Usage:
 *   # Smoke test on a single set
 *   node scripts/run-yahoo-jp-pipeline.mjs --set-code=neo1_ja
 *
 *   # Single canonical_slug
 *   node scripts/run-yahoo-jp-pipeline.mjs --slug=expansion-pack-6-charizard-jp
 *
 *   # Random sample for monitoring
 *   node scripts/run-yahoo-jp-pipeline.mjs --random-jp=20
 *
 *   # Dry run — show what would be written without persisting
 *   node scripts/run-yahoo-jp-pipeline.mjs --set-code=neo1_ja --dry-run
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional env: JPY_TO_USD_RATE (default 0.0068, matches lib/pricing/fx.ts)
 */

import dotenv from "dotenv";
import { statSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { scrapeYahooJp } from "./scrape-yahoo-jp.mjs";
import { buildPrecisionQuery, selectMatched } from "../lib/jp/matcher.mjs";

dotenv.config({ path: ".env.local" });

// Mirrors lib/pricing/fx.ts DEFAULT_JPY_TO_USD_RATE so the
// USD-converted column on card_metrics matches what the rest of the
// app would produce. If env var is set, it overrides.
const DEFAULT_JPY_TO_USD_RATE = 0.0068;
const JPY_TO_USD = (() => {
  const raw = process.env.JPY_TO_USD_RATE;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JPY_TO_USD_RATE;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry helper for Supabase queries. Wraps any async DB call so a single
 * transient `TypeError: fetch failed` (which happens occasionally on
 * rapid successive REST calls) doesn't kill a multi-hour backfill run.
 *
 * Retries on: any error (Postgres errors are usually deterministic so a
 * retry-then-bail strategy is fine — if it failed once it'll fail
 * again, and the backoff makes that quick). Exits the loop on success.
 *
 * Tuned for: ~28 page queries during the load phase (14k slugs ÷
 * 500/page) where any single flake would currently abort the whole run.
 */
async function withRetry(label, fn, { attempts = 4, baseDelayMs = 500 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const wait = baseDelayMs * Math.pow(2, attempt - 1);
        console.error(`[yahoo-jp-pipeline] ${label} attempt ${attempt}/${attempts} failed: ${err.message ?? err}. Retrying in ${wait}ms…`);
        await sleep(wait);
      }
    }
  }
  throw lastErr ?? new Error(`${label}: exhausted ${attempts} retries`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    slugs: [],
    setCode: null,
    randomJp: 0,
    allMatched: false,
    skipIfFresherThanHours: 24, // by default, skip cards refreshed within the last 24h (idempotent re-runs)
    pages: 1,
    minScore: 0.50,
    minSampleCount: 3, // require ≥3 raw sales for a confident median
    dryRun: false,
    interCardDelayMs: 1500,
    concurrency: 1,
    maxCards: null, // safety cap; null = no cap
    stopFile: "/tmp/yahoo-jp-stop", // touch this to halt cleanly
    json: false,
  };
  for (const a of args) {
    if (a.startsWith("--slug=")) opts.slugs.push(a.slice("--slug=".length));
    else if (a.startsWith("--slugs=")) opts.slugs.push(...a.slice("--slugs=".length).split(",").filter(Boolean));
    else if (a.startsWith("--set-code=")) opts.setCode = a.slice("--set-code=".length);
    else if (a.startsWith("--random-jp=")) opts.randomJp = Math.max(1, Number.parseInt(a.slice("--random-jp=".length), 10) || 0);
    else if (a === "--all-matched") opts.allMatched = true;
    else if (a.startsWith("--skip-fresher-than-hours=")) opts.skipIfFresherThanHours = Math.max(0, Number.parseFloat(a.slice("--skip-fresher-than-hours=".length)) || 0);
    else if (a.startsWith("--pages=")) opts.pages = Math.max(1, Number.parseInt(a.slice("--pages=".length), 10) || 1);
    else if (a.startsWith("--min-score=")) opts.minScore = Number.parseFloat(a.slice("--min-score=".length));
    else if (a.startsWith("--min-sample=")) opts.minSampleCount = Math.max(1, Number.parseInt(a.slice("--min-sample=".length), 10) || 1);
    else if (a.startsWith("--inter-card-delay=")) opts.interCardDelayMs = Math.max(0, Number.parseInt(a.slice("--inter-card-delay=".length), 10) || 0);
    else if (a.startsWith("--concurrency=")) opts.concurrency = Math.max(1, Math.min(8, Number.parseInt(a.slice("--concurrency=".length), 10) || 1));
    else if (a.startsWith("--max-cards=")) opts.maxCards = Math.max(1, Number.parseInt(a.slice("--max-cards=".length), 10) || 0) || null;
    else if (a.startsWith("--stop-file=")) opts.stopFile = a.slice("--stop-file=".length);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

async function loadCanonicalCards(supabase, opts) {
  // Mirrors scripts/match-yahoo-jp.mjs but uses the new native-name
  // columns post-backfill.
  const baseSelect = "slug, canonical_name, canonical_name_native, set_name, set_name_native, card_number, year, language";
  let rows = [];
  if (opts.slugs.length > 0) {
    const { data, error } = await supabase.from("canonical_cards").select(baseSelect).in("slug", opts.slugs);
    if (error) throw new Error(`canonical_cards: ${error.message}`);
    rows = data ?? [];
  } else if (opts.setCode) {
    // Cards in this set: join via card_printings.set_code
    const { data, error } = await supabase
      .from("canonical_cards")
      .select(`${baseSelect}, card_printings!inner(set_code)`)
      .eq("card_printings.set_code", opts.setCode)
      .eq("language", "JP");
    if (error) throw new Error(`canonical_cards by set: ${error.message}`);
    rows = data ?? [];
  } else if (opts.randomJp > 0) {
    const { count } = await supabase
      .from("canonical_cards").select("slug", { count: "exact", head: true }).eq("language", "JP");
    const total = count ?? 0;
    const offsets = new Set();
    while (offsets.size < Math.min(opts.randomJp, total)) {
      offsets.add(Math.floor(Math.random() * total));
    }
    for (const off of offsets) {
      const { data } = await supabase.from("canonical_cards").select(baseSelect)
        .eq("language", "JP").order("slug").range(off, off);
      if (data && data.length > 0) rows.push(data[0]);
    }
  } else if (opts.allMatched) {
    // Day 4 backfill path: every JP canonical_card that has at least one
    // MATCHED provider_card_map row. The inner join filters out the
    // ~5,975 JP slugs with no provider observations — Yahoo! signal is
    // unlikely there and scraping them wastes politeness budget.
    //
    // Order: most-recently-imported first (canonical_cards.created_at
    // DESC) so modern sets get covered first. If the run aborts halfway
    // we'll have hit the cards users are most likely to look at.
    //
    // Pagination: PostgREST defaults to 1000 rows per query; we page in
    // 1000-row chunks until done.
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const data = await withRetry(`canonical_cards(all-matched, page ${from})`, async () => {
        const { data, error } = await supabase
          .from("canonical_cards")
          .select(`${baseSelect}, provider_card_map!inner(mapping_status)`)
          .eq("language", "JP")
          .eq("provider_card_map.mapping_status", "MATCHED")
          .order("created_at", { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        return data ?? [];
      });
      if (data.length === 0) break;
      rows.push(...data);
      if (data.length < PAGE) break;
    }
  }
  // Dedup by slug (the join can return the same slug twice if a canonical
  // has multiple printings under the same set_code, OR multiple matched
  // provider_card_map rows for --all-matched).
  const seen = new Set();
  let deduped = rows.filter((r) => {
    if (seen.has(r.slug)) return false;
    seen.add(r.slug);
    return true;
  });

  // Skip cards refreshed recently — idempotent re-runs, also serves as
  // the de-facto checkpoint mechanism. If the script crashed mid-run
  // 30 minutes ago, the rows it wrote have observed_at within the
  // skip window and will be skipped on resume.
  if (opts.skipIfFresherThanHours > 0 && deduped.length > 0) {
    const cutoff = new Date(Date.now() - opts.skipIfFresherThanHours * 60 * 60 * 1000).toISOString();
    const slugs = deduped.map((r) => r.slug);
    // Page the recent-rows query because IN clauses get long with 14k slugs
    const recentlyDone = new Set();
    // Page size 200 keeps the IN-clause URL under 8KB (PostgREST/Cloudflare's
    // URI-length cutoff). At 500 slugs the URL was ~17KB and connections
    // were aborting before HTTP — surfaced as `TypeError: fetch failed`
    // from supabase-js, retried 4× because there's no response code to
    // distinguish "URL too long" from a transient network blip. 200 ×
    // ~35-char slug = ~7KB, comfortably under the limit.
    const SLUG_PAGE = 200;
    for (let i = 0; i < slugs.length; i += SLUG_PAGE) {
      const chunk = slugs.slice(i, i + SLUG_PAGE);
      const data = await withRetry(`yahoo_jp_card_prices(skip-fresh page ${i})`, async () => {
        const { data, error } = await supabase
          .from("yahoo_jp_card_prices")
          .select("canonical_slug")
          .eq("grade", "RAW")
          .gte("observed_at", cutoff)
          .in("canonical_slug", chunk);
        if (error) throw new Error(error.message);
        return data ?? [];
      });
      for (const r of data) recentlyDone.add(r.canonical_slug);
    }
    const before = deduped.length;
    deduped = deduped.filter((r) => !recentlyDone.has(r.slug));
    const skipped = before - deduped.length;
    if (skipped > 0) {
      console.log(`[yahoo-jp-pipeline] skipping ${skipped} card(s) refreshed within last ${opts.skipIfFresherThanHours}h (resume / idempotency)`);
    }
  }

  // Honor --max-cards safety cap (set after the skip filter so the cap
  // applies to actual work, not the universe).
  if (opts.maxCards != null && deduped.length > opts.maxCards) {
    deduped = deduped.slice(0, opts.maxCards);
  }

  return deduped;
}

/**
 * Persist a single canonical card's YAHOO_JP price into the dedicated
 * yahoo_jp_card_prices table. The public_card_metrics view JOINs this
 * data into the unified row that iOS reads.
 *
 * Why this isn't a write to card_metrics: that table is governed by the
 * SCRYDEX refresh functions (refresh_card_metrics + the targeted
 * variant), which do `DELETE FROM card_metrics WHERE NOT EXISTS
 * (recent SCRYDEX price_snapshots…)` at the end of every run. Vintage
 * JP cards without Scrydex coverage — exactly the segment this scraper
 * exists to serve — would have their yahoo_jp data wiped on the next
 * cron tick. Storing it on its own table sidesteps that GC entirely.
 * See migration 20260508140000 for the full design rationale.
 *
 * Target row: (canonical_slug, grade) — keyed identically to how the
 * future per-grade splits (PSA10, CGC10) will work. Today only
 * grade='RAW' is written; graded buckets are a follow-up.
 *
 * GRADE CATALOG (added 2026-05-08): a BEFORE INSERT/UPDATE trigger
 * resolves the text `grade` column to a `grade_id smallint` FK pointing
 * at `grade_definitions`. 'RAW' resolves to grade_id=1 automatically.
 * 'PSA10' is already in the catalog (grade_id=9). When this orchestrator
 * is extended to write graded buckets, any new grade string must exist
 * in `grade_definitions` (or as a row in `grade_aliases`) BEFORE the
 * first write — the trigger raises check_violation on unknown grades.
 * See docs/schema-audit-2026-05-08.md §8 item 3.
 *
 * Upsert semantics: ON CONFLICT (canonical_slug, grade) DO UPDATE.
 * The table has no NOT NULL columns beyond the PK + updated_at default,
 * so a sparse upsert works (unlike card_metrics, which had columns
 * like canonical_name on its row that the failed Day-2 backfill hit).
 */
async function writeYahooJpPrice(supabase, slug, payload) {
  const row = {
    canonical_slug: slug,
    printing_id: payload.printing_id ?? null, // null = canonical-level fallback (legacy / blended)
    grade: "RAW",
    price_usd: payload.yahoo_jp_price,
    price_jpy: payload.yahoo_jp_price_jpy,
    // Store the FX rate used so historical rows can be re-converted
    // if JPY_TO_USD_RATE drifts. Avoids auditability decay — see the
    // migration's fx_rate_used column comment.
    fx_rate_used: JPY_TO_USD,
    sample_count: payload.yahoo_jp_sample_count,
    observed_at: payload.yahoo_jp_observed_at,
    updated_at: new Date().toISOString(),
  };
  await withRetry(`yahoo_jp_card_prices upsert ${slug}/${payload.printing_id ?? "canonical"}`, async () => {
    const { error } = await supabase
      .from("yahoo_jp_card_prices")
      // PK is (canonical_slug, printing_id, grade) WITH NULLS NOT DISTINCT
      // so the canonical-level row (printing_id NULL) and per-printing
      // rows coexist; PostgREST onConflict needs all three columns.
      .upsert(row, { onConflict: "canonical_slug,printing_id,grade" });
    if (error) throw new Error(error.message);
  });
  // Append a time-series row to jp_card_price_history so
  // compute_jp_card_price_changes (a follow-on migration) can derive
  // 24h/7d change_pct from JP-native observations. printing_id is
  // mirrored from the latest-price row so per-printing time series
  // (HOLO / Reverse Holo / etc.) stay separated; mixing them would
  // make the eventual delta math compare unrelated prices. The history
  // table is append-only — every pipeline run leaves a new
  // (recorded_at) row even when the price hasn't changed, which is
  // what the delta math needs. Failure here is non-fatal: the
  // current-price upsert above already succeeded and we don't want to
  // fail the pipeline over the history append.
  try {
    const { error: historyError } = await supabase
      .from("jp_card_price_history")
      .insert({
        canonical_slug: slug,
        printing_id: row.printing_id,
        grade: row.grade,
        source: "yahoo_jp",
        price_jpy: row.price_jpy,
        price_usd: row.price_usd,
        sample_count: row.sample_count,
        observed_at: row.observed_at,
      });
    if (historyError) {
      console.warn(`[yahoo-jp] jp_card_price_history append failed for ${slug}: ${historyError.message}`);
    }
  } catch (err) {
    console.warn(`[yahoo-jp] jp_card_price_history append threw for ${slug}:`, err instanceof Error ? err.message : err);
  }
  return { mode: "upserted" };
}

/**
 * Fetch a canonical card's printings (id + finish) so the matcher can
 * attribute observations per-printing. Returns [] if the card has no
 * card_printings rows — selectMatched then collapses to legacy
 * one-observation-per-grade behavior.
 */
async function loadPrintings(supabase, slug) {
  return withRetry(`card_printings load ${slug}`, async () => {
    const { data, error } = await supabase
      .from("card_printings")
      .select("id, finish")
      .eq("canonical_slug", slug);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
}

async function processCard(supabase, card, opts) {
  const query = buildPrecisionQuery(card);
  if (!query.query) {
    return { slug: card.slug, status: "no-query", reason: "could-not-construct-jp-query" };
  }

  let scrape;
  try {
    scrape = await scrapeYahooJp(query.query, { mode: "closed", maxPages: opts.pages });
  } catch (err) {
    return { slug: card.slug, status: "scrape-failed", reason: err.message };
  }

  // Load printings so the matcher can split observations by detected
  // finish. For single-printing cards (most JP cards), every observation
  // is attributed to that one printing. For multi-printing cards, the
  // matcher splits per-finish via lib/jp/matcher.mjs's extractFinish.
  // Failures fall back to no-printings behavior (legacy single
  // observation per grade), so per-printing is best-effort enrichment.
  let printings = [];
  try {
    printings = await loadPrintings(supabase, card.slug);
  } catch (err) {
    // Non-fatal — keep going with empty printings; matcher will
    // collapse to canonical-only behavior.
    console.warn(`[yahoo-jp-pipeline] loadPrintings(${card.slug}) failed: ${err.message}`);
  }

  const result = selectMatched(scrape.listings, card, {
    minScore: opts.minScore,
    printings,
  });
  const rawObs = result.priceObservations.find((o) => o.grade === "RAW");
  if (!rawObs || rawObs.count < opts.minSampleCount) {
    return {
      slug: card.slug,
      status: "low-sample",
      query: query.query,
      scraped: result.inputCount,
      accepted: result.accepted,
      rawCount: rawObs?.count ?? 0,
      minRequired: opts.minSampleCount,
    };
  }

  const observedAt = new Date().toISOString();

  // All observations whose count meets the min threshold get written. The
  // matcher returns:
  //   • Per-printing observations (printing_id != null) when finish is
  //     detected with enough samples to disambiguate
  //   • A canonical-level rollup (printing_id == null) with the blended
  //     median across all printings, written every time so iOS has a
  //     fallback when no per-printing row exists yet for a given
  //     printing
  const writableObs = result.priceObservations.filter(
    (o) => o.grade === "RAW" && o.count >= opts.minSampleCount,
  );
  const yenMedian = rawObs.median;
  const usdMedian = Math.round(yenMedian * JPY_TO_USD * 100) / 100;

  if (opts.dryRun) {
    return {
      slug: card.slug,
      status: "dry-run",
      query: query.query,
      scraped: result.inputCount,
      accepted: result.accepted,
      rawCount: rawObs.count,
      yahoo_jp_price_jpy: yenMedian,
      yahoo_jp_price: usdMedian,
      yahoo_jp_observed_at: observedAt,
      observationsToWrite: writableObs.map((o) => ({
        printing_id: o.printing_id,
        finish: o.finish,
        count: o.count,
        median_jpy: o.median,
      })),
      sampleListings: rawObs.samples?.slice(0, 3) ?? [],
    };
  }

  let rowsWritten = 0;
  let writeResult;
  try {
    for (const obs of writableObs) {
      const obsYen = obs.median;
      const obsUsd = Math.round(obsYen * JPY_TO_USD * 100) / 100;
      writeResult = await writeYahooJpPrice(supabase, card.slug, {
        printing_id: obs.printing_id,
        yahoo_jp_price: obsUsd,
        yahoo_jp_price_jpy: obsYen,
        yahoo_jp_sample_count: obs.count,
        yahoo_jp_observed_at: observedAt,
      });
      rowsWritten += 1;
    }
  } catch (err) {
    return { slug: card.slug, status: "write-failed", reason: err.message };
  }

  return {
    slug: card.slug,
    status: "ok",
    query: query.query,
    scraped: result.inputCount,
    accepted: result.accepted,
    rawCount: rawObs.count,
    rowsWritten,
    perPrintingRows: writableObs.filter((o) => o.printing_id != null).length,
    yahoo_jp_price_jpy: yenMedian,
    yahoo_jp_price: usdMedian,
    write_mode: writeResult?.mode ?? "noop",
  };
}

// Health window — used to auto-halt if Yahoo! pushes back. Tracks the
// outcome of the most recent N cards in an FIFO-style ring. We'll halt
// if either:
//   • Last 20 consecutive cards all failed at the scrape layer (likely
//     IP block / rate limit / captcha)
//   • Last 50 cards in a row all came back zero matches AND we KNOW
//     these cards have observations (matched provider rows) — strong
//     signal that the page contents shifted (maybe captcha HTML)
const HEALTH_WINDOW_SIZE = 50;
const HALT_ON_CONSECUTIVE_SCRAPE_FAILS = 20;
const HALT_ON_CONSECUTIVE_ZERO_MATCHES = 50;

class HealthTracker {
  constructor() {
    this.window = []; // {status, scraped} for last N cards
    this.consecutiveScrapeFails = 0;
    this.consecutiveZeroMatches = 0;
  }
  record(result) {
    this.window.push({ status: result.status, scraped: result.scraped ?? 0 });
    if (this.window.length > HEALTH_WINDOW_SIZE) this.window.shift();
    if (result.status === "scrape-failed") this.consecutiveScrapeFails += 1;
    else this.consecutiveScrapeFails = 0;
    if (result.status !== "scrape-failed" && (result.scraped ?? 0) === 0) this.consecutiveZeroMatches += 1;
    else this.consecutiveZeroMatches = 0;
  }
  haltReason() {
    if (this.consecutiveScrapeFails >= HALT_ON_CONSECUTIVE_SCRAPE_FAILS) {
      return `${this.consecutiveScrapeFails} consecutive scrape-failed responses — likely IP block / rate limit / captcha`;
    }
    if (this.consecutiveZeroMatches >= HALT_ON_CONSECUTIVE_ZERO_MATCHES) {
      return `${this.consecutiveZeroMatches} consecutive zero-result scrapes on matched cards — page contents may have shifted (captcha?)`;
    }
    return null;
  }
  summary() {
    const scrapeFailRate = this.window.filter((w) => w.status === "scrape-failed").length / Math.max(1, this.window.length);
    const zeroMatchRate = this.window.filter((w) => (w.scraped ?? 0) === 0).length / Math.max(1, this.window.length);
    return { scrapeFailRate, zeroMatchRate, sample: this.window.length };
  }
}

function shouldStopForKillSwitch(stopFile) {
  // The user touches this file to halt the run cleanly between batches.
  // Cheap stat() — fine to do every batch.
  //
  // Bug-fix history: the original implementation called
  // `require("node:fs")` inside this function, which is a CommonJS
  // builtin. This script is .mjs (ESM), so `require` is undefined —
  // every check threw ReferenceError and was silently caught by the
  // try/catch, returning false. The kill switch never fired during
  // the v4 backfill on May 8 night-one. Fixed by importing statSync
  // at module scope.
  if (!stopFile) return false;
  try {
    statSync(stopFile);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const cards = await loadCanonicalCards(supabase, opts);
  if (cards.length === 0) {
    console.error("[yahoo-jp-pipeline] no canonical cards matched the input filters");
    process.exit(1);
  }

  const ratePerSec = opts.concurrency / Math.max(0.5, opts.interCardDelayMs / 1000);
  const etaMin = Math.round(cards.length / ratePerSec / 60);
  console.log(`[yahoo-jp-pipeline] processing ${cards.length} canonical card(s) — JPY/USD ${JPY_TO_USD} | concurrency ${opts.concurrency} | inter-batch ${opts.interCardDelayMs}ms | dry-run ${opts.dryRun}`);
  console.log(`[yahoo-jp-pipeline] approx ETA: ${etaMin} minutes (${(etaMin / 60).toFixed(1)} hours)`);
  console.log(`[yahoo-jp-pipeline] kill switch: \`touch ${opts.stopFile}\` halts cleanly between batches`);

  const startedAt = Date.now();
  const health = new HealthTracker();
  let okCount = 0;
  let lowSampleCount = 0;
  let scrapeFailedCount = 0;
  let writeFailedCount = 0;
  let noQueryCount = 0;
  let processed = 0;
  let halted = false;
  let haltReason = null;

  // Concurrency: process cards in fixed-size parallel batches. Simpler
  // than a true async pool and easier to reason about for politeness:
  // each batch fires N requests roughly simultaneously, then waits the
  // inter-card delay before the next batch. So Yahoo! sees roughly
  // (concurrency / delaySec) requests/sec on average — at concurrency=3
  // and delay=1500ms, that's 2 req/sec, well below their bot-detection
  // threshold for unauthenticated browsers.
  for (let batchStart = 0; batchStart < cards.length; batchStart += opts.concurrency) {
    if (shouldStopForKillSwitch(opts.stopFile)) {
      haltReason = `kill switch file ${opts.stopFile} present`;
      halted = true;
      break;
    }

    const batch = cards.slice(batchStart, batchStart + opts.concurrency);
    const batchResults = await Promise.all(batch.map((card) => processCard(supabase, card, opts)));

    for (let bi = 0; bi < batch.length; bi += 1) {
      const card = batch[bi];
      const result = batchResults[bi];
      health.record(result);
      processed += 1;
      const tag = result.status === "ok" ? "✓" : result.status === "dry-run" ? "·" : "✗";
      const yenStr = result.yahoo_jp_price_jpy ? `¥${result.yahoo_jp_price_jpy.toLocaleString("en-US")}` : "—";
      const usdStr = result.yahoo_jp_price ? `$${result.yahoo_jp_price.toFixed(2)}` : "—";
      const nStr = result.rawCount != null ? `n=${result.rawCount}` : "";
      const reason = result.reason ?? result.status;
      console.log(`[yahoo-jp-pipeline] ${processed}/${cards.length} ${tag} ${card.slug.slice(0, 50).padEnd(50)} ${yenStr.padStart(11)} ${usdStr.padStart(9)} ${nStr.padStart(7)}  ${result.status === "ok" || result.status === "dry-run" ? "" : reason}`);

      if (result.status === "ok") okCount += 1;
      else if (result.status === "low-sample") lowSampleCount += 1;
      else if (result.status === "scrape-failed") scrapeFailedCount += 1;
      else if (result.status === "write-failed") writeFailedCount += 1;
      else if (result.status === "no-query") noQueryCount += 1;
    }

    // Health gate — auto-halt if signals indicate Yahoo! is pushing back.
    haltReason = health.haltReason();
    if (haltReason) {
      halted = true;
      const fileSafetyMsg = "Run will exit; the orchestrator will SKIP cards refreshed within the last 24h on resume, so re-running is idempotent.";
      console.error(`[yahoo-jp-pipeline] AUTO-HALT: ${haltReason}`);
      console.error(`[yahoo-jp-pipeline] ${fileSafetyMsg}`);
      break;
    }

    // Periodic summary every 100 cards — gives the user a clean grep
    // target ("HEALTH") for monitoring without needing to read every
    // per-card line.
    if (processed % 100 === 0 && processed > 0) {
      const sec = (Date.now() - startedAt) / 1000;
      const remaining = cards.length - processed;
      const remMin = Math.round(remaining / Math.max(0.1, processed / sec) / 60);
      const sum = health.summary();
      console.log(`[yahoo-jp-pipeline] HEALTH ${processed}/${cards.length} ok=${okCount} low-sample=${lowSampleCount} scrape-fail=${scrapeFailedCount} write-fail=${writeFailedCount} | window-fail-rate=${(sum.scrapeFailRate * 100).toFixed(1)}% zero-match-rate=${(sum.zeroMatchRate * 100).toFixed(1)}% | ETA ${remMin}min`);
    }

    // Politeness inter-batch delay
    if (batchStart + opts.concurrency < cards.length) {
      await sleep(opts.interCardDelayMs + Math.random() * 250);
    }
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log("");
  console.log(`[yahoo-jp-pipeline] ${halted ? "HALTED" : "DONE"} in ${elapsedSec}s: ${okCount} written, ${lowSampleCount} low-sample, ${scrapeFailedCount} scrape-failed, ${writeFailedCount} write-failed, ${noQueryCount} no-query`);
  if (halted) {
    console.log(`[yahoo-jp-pipeline] HALT REASON: ${haltReason}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[yahoo-jp-pipeline] FAILED:", err);
  process.exit(1);
});
