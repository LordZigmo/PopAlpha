#!/usr/bin/env node
/**
 * Snkrdunk pipeline runner — production batch ingestion.
 *
 * Mirrors scripts/run-yahoo-jp-pipeline.mjs structure (auto-halt, retry,
 * kill-switch, idempotent resume via observed_at) but for Snkrdunk's
 * /en/v1/products/SW---<id>/used-listings endpoint.
 *
 * Critical architectural difference from Yahoo!:
 *   Yahoo!  → search by query ("リザードン")     → match listings  → write
 *   Snkrdunk → know product code (SW---91103)    → fetch listings → write
 *
 * The product code is the catalog mapping — given a canonical_slug, what
 * Snkrdunk product corresponds to it? For v0 we accept that mapping as
 * INPUT (CLI args or CSV file) rather than discovering it. Building the
 * automated catalog mapper (sitemap-walk + fuzzy-match against
 * canonical_cards) is a separate concern and a follow-up to this
 * pipeline. v0 ships with hand-curated mappings for high-value cards;
 * v1 adds the auto-discovery.
 *
 * Usage:
 *   # Single card (smoke test) — explicit slug + product-code
 *   node scripts/run-snkrdunk-pipeline.mjs --slug=<slug> --product-code=SW---91103
 *
 *   # Bulk from CSV — two columns: canonical_slug,snkrdunk_product_code
 *   node scripts/run-snkrdunk-pipeline.mjs --from-csv=./snkrdunk-map.csv
 *
 *   # NEW (Step D): bulk from the snkrdunk_product_map table — reads all
 *   # MATCHED rows so the operator doesn't need to maintain a CSV.
 *   # Populate the table first via scripts/match-snkrdunk-canonical.mjs +
 *   # scripts/persist-snkrdunk-matches.mjs.
 *   node scripts/run-snkrdunk-pipeline.mjs --from-map
 *
 *   # Dry run — show what would be written without persisting
 *   node scripts/run-snkrdunk-pipeline.mjs --slug=X --product-code=SW---Y --dry-run
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import dotenv from "dotenv";
import { statSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { scrapeSnkrdunk, SnkrdunkPushbackError } from "./scrape-snkrdunk.mjs";
import { aggregateSnkrdunkListings } from "../lib/jp/snkrdunk-matcher.mjs";

dotenv.config({ path: ".env.local" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, { attempts = 4, baseDelayMs = 500 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // SnkrdunkPushbackError is intentionally NOT retried — it's a halt
      // signal, not a transient flake. Propagate immediately.
      if (err instanceof SnkrdunkPushbackError) throw err;
      if (attempt < attempts) {
        const wait = baseDelayMs * Math.pow(2, attempt - 1);
        console.error(`[snkrdunk-pipeline] ${label} attempt ${attempt}/${attempts} failed: ${err.message ?? err}. Retrying in ${wait}ms…`);
        await sleep(wait);
      }
    }
  }
  throw lastErr ?? new Error(`${label}: exhausted ${attempts} retries`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    // Input modes — exactly one of these must be specified
    slug: null,
    productCode: null,
    fromCsv: null,
    fromMap: false, // Step D: read MATCHED rows from snkrdunk_product_map
    // Behavior
    skipIfFresherThanHours: 24,
    pages: 4, // most Snkrdunk products have ≤2 pages; 4 is safe upper bound
    minSampleCount: 3,
    dryRun: false,
    interCardDelayMs: 2000, // polite default — Snkrdunk's robots.txt asks us not to crawl /en/v1/
    concurrency: 1, // start conservative; can raise after verifying no pushback
    maxCards: null,
    stopFile: "/tmp/snkrdunk-stop",
    json: false,
  };
  for (const a of args) {
    if (a.startsWith("--slug=")) opts.slug = a.slice("--slug=".length);
    else if (a.startsWith("--product-code=")) opts.productCode = a.slice("--product-code=".length);
    else if (a.startsWith("--from-csv=")) opts.fromCsv = a.slice("--from-csv=".length);
    else if (a === "--from-map") opts.fromMap = true;
    else if (a.startsWith("--skip-fresher-than-hours=")) opts.skipIfFresherThanHours = Math.max(0, Number.parseFloat(a.slice("--skip-fresher-than-hours=".length)) || 0);
    else if (a.startsWith("--pages=")) opts.pages = Math.max(1, Number.parseInt(a.slice("--pages=".length), 10) || 1);
    else if (a.startsWith("--min-sample=")) opts.minSampleCount = Math.max(1, Number.parseInt(a.slice("--min-sample=".length), 10) || 1);
    else if (a.startsWith("--inter-card-delay=")) opts.interCardDelayMs = Math.max(0, Number.parseInt(a.slice("--inter-card-delay=".length), 10) || 0);
    else if (a.startsWith("--concurrency=")) opts.concurrency = Math.max(1, Math.min(4, Number.parseInt(a.slice("--concurrency=".length), 10) || 1));
    else if (a.startsWith("--max-cards=")) opts.maxCards = Math.max(1, Number.parseInt(a.slice("--max-cards=".length), 10) || 0) || null;
    else if (a.startsWith("--stop-file=")) opts.stopFile = a.slice("--stop-file=".length);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

/**
 * Parse "canonical_slug,snkrdunk_product_code" CSV. Tolerant of:
 *   - Blank lines
 *   - # comment lines
 *   - Optional 3rd column with a human-readable note (ignored)
 */
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    const parts = trimmed.split(",").map((s) => s.trim());
    if (parts.length < 2) continue;
    const [slug, productCode] = parts;
    if (!slug || !productCode) continue;
    out.push({ slug, productCode });
  }
  return out;
}

/**
 * Build the input list (canonical_slug, snkrdunk_product_code) from CLI
 * args. Applies the freshness-skip filter against snkrdunk_card_prices
 * so re-runs are idempotent (a card refreshed in the last N hours is
 * skipped).
 */
async function loadInputList(supabase, opts) {
  // 1. Pull raw input pairs
  let pairs = [];
  if (opts.fromMap) {
    // Step D: read MATCHED rows from snkrdunk_product_map. Page through
    // because there could be tens of thousands of mappings.
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const data = await withRetry(`snkrdunk_product_map page ${from}`, async () => {
        const { data, error } = await supabase
          .from("snkrdunk_product_map")
          .select("canonical_slug, snkrdunk_product_code")
          .eq("mapping_status", "MATCHED")
          .order("canonical_slug")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        return data ?? [];
      });
      if (data.length === 0) break;
      for (const r of data) {
        pairs.push({ slug: r.canonical_slug, productCode: r.snkrdunk_product_code });
      }
      if (data.length < PAGE) break;
    }
    if (pairs.length === 0) {
      console.warn("[snkrdunk-pipeline] --from-map produced 0 MATCHED rows from snkrdunk_product_map");
      console.warn("[snkrdunk-pipeline] Run scripts/match-snkrdunk-canonical.mjs + scripts/persist-snkrdunk-matches.mjs first.");
      return [];
    }
    console.log(`[snkrdunk-pipeline] --from-map loaded ${pairs.length} MATCHED row(s) from snkrdunk_product_map`);
  } else if (opts.fromCsv) {
    const text = readFileSync(opts.fromCsv, "utf8");
    pairs = parseCsv(text);
    if (pairs.length === 0) {
      throw new Error(`CSV at ${opts.fromCsv} produced 0 valid rows`);
    }
  } else if (opts.slug && opts.productCode) {
    pairs = [{ slug: opts.slug, productCode: opts.productCode }];
  } else {
    throw new Error("Specify --slug + --product-code, --from-csv=<path>, or --from-map");
  }

  // 2. Skip recently-refreshed slugs for idempotent resume
  if (opts.skipIfFresherThanHours > 0 && pairs.length > 0) {
    const cutoff = new Date(Date.now() - opts.skipIfFresherThanHours * 60 * 60 * 1000).toISOString();
    const slugs = pairs.map((p) => p.slug);
    const recentlyDone = new Set();
    const SLUG_PAGE = 200; // same URL-length cap as Yahoo! pipeline
    for (let i = 0; i < slugs.length; i += SLUG_PAGE) {
      const chunk = slugs.slice(i, i + SLUG_PAGE);
      const data = await withRetry(`snkrdunk_card_prices(skip-fresh page ${i})`, async () => {
        const { data, error } = await supabase
          .from("snkrdunk_card_prices")
          .select("canonical_slug")
          .gte("observed_at", cutoff)
          .in("canonical_slug", chunk);
        if (error) throw new Error(error.message);
        return data ?? [];
      });
      for (const r of data) recentlyDone.add(r.canonical_slug);
    }
    const before = pairs.length;
    pairs = pairs.filter((p) => !recentlyDone.has(p.slug));
    const skipped = before - pairs.length;
    if (skipped > 0) {
      console.log(`[snkrdunk-pipeline] skipping ${skipped} card(s) refreshed within last ${opts.skipIfFresherThanHours}h`);
    }
  }

  // 3. Apply max-cards safety cap
  if (opts.maxCards != null && pairs.length > opts.maxCards) {
    pairs = pairs.slice(0, opts.maxCards);
  }
  return pairs;
}

/**
 * Pull the printing_id for a (canonical_slug, snkrdunk_product_code) pair.
 *
 * v0 simplification: we assume the catalog-mapping job (when it ships)
 * will write directly to snkrdunk_card_prices.printing_id via the same
 * persisted map. For now, if the canonical has exactly ONE printing,
 * use that. Otherwise leave printing_id NULL (canonical-level rollup
 * only) — the matcher will write to printing_id=NULL, which iOS still
 * surfaces via the public_card_metrics COALESCE pattern.
 *
 * Future enhancement: the catalog mapper writes (canonical_slug,
 * printing_id, snkrdunk_product_code) tuples to a dedicated map table,
 * and we look up printing_id from there.
 */
async function resolvePrintingId(supabase, slug) {
  const data = await withRetry(`card_printings load ${slug}`, async () => {
    const { data, error } = await supabase
      .from("card_printings")
      .select("id")
      .eq("canonical_slug", slug);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
  if (data.length === 1) return data[0].id;
  // Multi-printing or no-printing: write to canonical-level only.
  return null;
}

// Mirror of run-yahoo-jp-daily/route.ts: parse JPY_TO_USD_RATE from env
// with a 0.0068 fallback (~147 JPY/USD). Used at write time to derive
// price_jpy for the "¥X,XXX ($X)" tile display added in Phase C-1b
// (2026-05-16). Snkrdunk's English API serves USD only, so this is an
// FX-derived approximation, not the seller's listed yen value.
const DEFAULT_JPY_TO_USD_RATE = 0.0068;
const JPY_TO_USD = (() => {
  const raw = process.env.JPY_TO_USD_RATE;
  const parsed = raw != null ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JPY_TO_USD_RATE;
})();

async function writeSnkrdunkPrice(supabase, slug, payload) {
  const priceUsd = payload.price_usd;
  // Derive JPY from USD at write time. ROUND to integer yen (yen has no
  // subunit in everyday use). Skip when price_usd is missing.
  const priceJpy = typeof priceUsd === "number" && Number.isFinite(priceUsd) && priceUsd > 0
    ? Math.round(priceUsd / JPY_TO_USD)
    : null;
  const row = {
    canonical_slug: slug,
    printing_id: payload.printing_id ?? null,
    grade: payload.grade ?? "RAW",
    price_usd: priceUsd,
    price_jpy: priceJpy,
    fx_rate_used: priceJpy != null ? JPY_TO_USD : null,
    currency: payload.currency ?? "USD",
    sample_count: payload.sample_count,
    snkrdunk_product_code: payload.snkrdunk_product_code,
    observed_at: payload.observed_at,
    updated_at: new Date().toISOString(),
  };
  await withRetry(`snkrdunk_card_prices upsert ${slug}/${payload.printing_id ?? "canonical"}/${row.grade}`, async () => {
    const { error } = await supabase
      .from("snkrdunk_card_prices")
      .upsert(row, { onConflict: "canonical_slug,printing_id,grade" });
    if (error) throw new Error(error.message);
  });
  // Append a time-series row to jp_card_price_history so a future
  // compute_jp_card_price_changes() can derive change_pct from Snkrdunk
  // observations. printing_id is mirrored from the latest-price row so
  // per-printing time series stay separated — mixing canonical-level
  // and per-printing observations into the same series would make the
  // eventual delta math compare unrelated prices. See migration
  // 20260516190625_jp_card_price_history.sql for the design rationale.
  // Failure is non-fatal — the current-price upsert above already
  // succeeded and we don't want a history-append hiccup to fail the
  // whole pipeline.
  try {
    const { error: historyError } = await supabase
      .from("jp_card_price_history")
      .insert({
        canonical_slug: slug,
        printing_id: row.printing_id,
        grade: row.grade,
        source: "snkrdunk",
        price_jpy: row.price_jpy,
        price_usd: row.price_usd,
        sample_count: row.sample_count,
        observed_at: row.observed_at,
      });
    if (historyError) {
      console.warn(`[snkrdunk] jp_card_price_history append failed for ${slug}: ${historyError.message}`);
    }
  } catch (err) {
    console.warn(`[snkrdunk] jp_card_price_history append threw for ${slug}:`, err instanceof Error ? err.message : err);
  }
  return { mode: "upserted" };
}

async function processCard(supabase, pair, opts) {
  const { slug, productCode } = pair;
  // Trim "SW---" prefix to recover the trading-card-id
  const tradingCardId = productCode.startsWith("SW---") ? productCode.slice("SW---".length) : productCode;

  // Resolve printing first (cheap query, lets us tag rows correctly)
  let printingId = null;
  try {
    printingId = await resolvePrintingId(supabase, slug);
  } catch (err) {
    console.warn(`[snkrdunk-pipeline] resolvePrintingId(${slug}) failed (non-fatal): ${err.message}`);
  }

  // Scrape — pushback propagates, other errors are slug-local
  let scrape;
  try {
    scrape = await scrapeSnkrdunk(tradingCardId, { maxPages: opts.pages });
  } catch (err) {
    if (err instanceof SnkrdunkPushbackError) throw err;
    return { slug, productCode, status: "scrape-failed", reason: err.message };
  }

  // Aggregate — bucket by condition, compute medians
  const agg = aggregateSnkrdunkListings(scrape.listings, {
    canonicalSlug: slug,
    printingId,
  });

  // Filter to observations that meet the min-sample threshold
  const writableObs = agg.priceObservations.filter((o) => o.count >= opts.minSampleCount);
  if (writableObs.length === 0) {
    return {
      slug,
      productCode,
      status: "low-sample",
      scraped: agg.inputCount,
      accepted: agg.accepted,
      droppedConditions: agg.droppedConditions,
      minRequired: opts.minSampleCount,
    };
  }

  const observedAt = new Date().toISOString();

  // For dry-run AND ok-status, pick the canonical RAW row as the
  // "summary" observation surfaced in the per-card log line.
  const summaryObs =
    writableObs.find((o) => o.grade === "RAW" && o.printing_id === null) ??
    writableObs.find((o) => o.grade === "RAW") ??
    writableObs[0];

  if (opts.dryRun) {
    return {
      slug,
      productCode,
      status: "dry-run",
      scraped: agg.inputCount,
      accepted: agg.accepted,
      droppedConditions: agg.droppedConditions,
      snkrdunk_price: summaryObs?.median ?? null,
      grade: summaryObs?.grade ?? null,
      sampleCount: summaryObs?.count ?? null,
      observationsToWrite: writableObs.map((o) => ({
        printing_id: o.printing_id,
        grade: o.grade,
        count: o.count,
        median: o.median,
        currency: o.currency,
      })),
    };
  }

  let rowsWritten = 0;
  try {
    for (const obs of writableObs) {
      await writeSnkrdunkPrice(supabase, slug, {
        printing_id: obs.printing_id,
        grade: obs.grade,
        price_usd: obs.median, // Snkrdunk gives USD directly
        currency: obs.currency,
        sample_count: obs.count,
        snkrdunk_product_code: productCode,
        observed_at: observedAt,
      });
      rowsWritten += 1;
    }
  } catch (err) {
    return { slug, productCode, status: "write-failed", reason: err.message };
  }

  return {
    slug,
    productCode,
    status: "ok",
    scraped: agg.inputCount,
    accepted: agg.accepted,
    rowsWritten,
    perPrintingRows: writableObs.filter((o) => o.printing_id != null).length,
    snkrdunk_price: summaryObs?.median ?? null,
    grade: summaryObs?.grade ?? null,
    sampleCount: summaryObs?.count ?? null,
  };
}

// =============================================================================
// Health + kill switch (mirrors run-yahoo-jp-pipeline.mjs)
// =============================================================================
const HEALTH_WINDOW_SIZE = 50;
const HALT_ON_CONSECUTIVE_SCRAPE_FAILS = 20;
const HALT_ON_CONSECUTIVE_ZERO_MATCHES = 50;

class HealthTracker {
  constructor() {
    this.window = [];
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
      return `${this.consecutiveScrapeFails} consecutive scrape-failed responses — likely IP block / rate limit`;
    }
    if (this.consecutiveZeroMatches >= HALT_ON_CONSECUTIVE_ZERO_MATCHES) {
      return `${this.consecutiveZeroMatches} consecutive zero-result scrapes`;
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

  const pairs = await loadInputList(supabase, opts);
  if (pairs.length === 0) {
    console.error("[snkrdunk-pipeline] no inputs after freshness filter — nothing to do");
    process.exit(0);
  }

  const ratePerSec = opts.concurrency / Math.max(0.5, opts.interCardDelayMs / 1000);
  const etaMin = Math.round(pairs.length / ratePerSec / 60);
  console.log(`[snkrdunk-pipeline] processing ${pairs.length} card(s) | concurrency ${opts.concurrency} | inter-batch ${opts.interCardDelayMs}ms | dry-run ${opts.dryRun}`);
  console.log(`[snkrdunk-pipeline] approx ETA: ${etaMin} minutes`);
  console.log(`[snkrdunk-pipeline] kill switch: \`touch ${opts.stopFile}\` halts cleanly between batches`);

  const startedAt = Date.now();
  const health = new HealthTracker();
  let okCount = 0;
  let lowSampleCount = 0;
  let scrapeFailedCount = 0;
  let writeFailedCount = 0;
  let processed = 0;
  let halted = false;
  let haltReason = null;

  outer:
  for (let batchStart = 0; batchStart < pairs.length; batchStart += opts.concurrency) {
    if (shouldStopForKillSwitch(opts.stopFile)) {
      haltReason = `kill switch file ${opts.stopFile} present`;
      halted = true;
      break;
    }

    const batch = pairs.slice(batchStart, batchStart + opts.concurrency);
    let batchResults;
    try {
      batchResults = await Promise.all(batch.map((pair) => processCard(supabase, pair, opts)));
    } catch (err) {
      if (err instanceof SnkrdunkPushbackError) {
        haltReason = `Snkrdunk pushback: ${err.message}`;
        halted = true;
        console.error(`[snkrdunk-pipeline] AUTO-HALT: ${haltReason}`);
        break outer;
      }
      throw err;
    }

    for (let bi = 0; bi < batch.length; bi += 1) {
      const pair = batch[bi];
      const result = batchResults[bi];
      health.record(result);
      processed += 1;
      const tag = result.status === "ok" ? "✓" : result.status === "dry-run" ? "·" : "✗";
      const priceStr = result.snkrdunk_price ? `$${Number(result.snkrdunk_price).toFixed(2)}` : "—";
      const nStr = result.sampleCount != null ? `n=${result.sampleCount}` : "";
      const reason = result.reason ?? result.status;
      console.log(`[snkrdunk-pipeline] ${processed}/${pairs.length} ${tag} ${pair.slug.slice(0, 50).padEnd(50)} ${priceStr.padStart(9)} ${nStr.padStart(7)}  ${result.status === "ok" || result.status === "dry-run" ? "" : reason}`);

      if (result.status === "ok") okCount += 1;
      else if (result.status === "low-sample") lowSampleCount += 1;
      else if (result.status === "scrape-failed") scrapeFailedCount += 1;
      else if (result.status === "write-failed") writeFailedCount += 1;
    }

    haltReason = health.haltReason();
    if (haltReason) {
      halted = true;
      console.error(`[snkrdunk-pipeline] AUTO-HALT: ${haltReason}`);
      console.error(`[snkrdunk-pipeline] Re-run is idempotent (skip-fresher-than-hours filter on resume).`);
      break;
    }

    if (processed % 100 === 0 && processed > 0) {
      const sec = (Date.now() - startedAt) / 1000;
      const remaining = pairs.length - processed;
      const remMin = Math.round(remaining / Math.max(0.1, processed / sec) / 60);
      const sum = health.summary();
      console.log(`[snkrdunk-pipeline] HEALTH ${processed}/${pairs.length} ok=${okCount} low-sample=${lowSampleCount} scrape-fail=${scrapeFailedCount} write-fail=${writeFailedCount} | window-fail-rate=${(sum.scrapeFailRate * 100).toFixed(1)}% zero-match-rate=${(sum.zeroMatchRate * 100).toFixed(1)}% | ETA ${remMin}min`);
    }

    if (batchStart + opts.concurrency < pairs.length) {
      await sleep(opts.interCardDelayMs);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`[snkrdunk-pipeline] DONE in ${elapsed}s — processed ${processed}/${pairs.length}`);
  console.log(`[snkrdunk-pipeline] ok=${okCount} low-sample=${lowSampleCount} scrape-fail=${scrapeFailedCount} write-fail=${writeFailedCount}`);
  if (halted) {
    console.error(`[snkrdunk-pipeline] HALTED: ${haltReason}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[snkrdunk-pipeline] FATAL:", err);
  process.exit(1);
});
