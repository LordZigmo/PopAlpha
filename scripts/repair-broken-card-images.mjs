#!/usr/bin/env node

// One-shot sweeper for dead image URLs already in the database.
//
// Pairs with the write-path validator in import-pokemon-tcg-data-local.mjs
// and import-scrydex-canonical-direct.mjs. Those guard new writes; this
// scrubs pre-existing rows.
//
// For every card_printings.image_url / canonical_cards.primary_image_url
// that HEAD-returns 404 or 410, NULL the URL and stamp
// image_mirror_last_error with the probe verdict. Leaves mirrored_* columns
// alone — if we already mirrored a valid copy, it keeps serving.
//
// Dry-run by default. Pass --apply to actually write.
//
// Usage:
//   node scripts/repair-broken-card-images.mjs [options]
//
// Options:
//   --apply                 Write updates. Default is dry-run.
//   --table=<name>          card_printings | canonical_cards | both (default: both)
//   --source=<name>         Filter card_printings by source (e.g. pokemon-tcg-data).
//                           Has no effect on canonical_cards (no source column).
//   --limit=<n>             Cap rows scanned per table (default: no cap).
//   --batch=<n>             Page size for the scan (default: 1000).
//   --concurrency=<n>       HEAD probes in flight (default: 10).
//   --timeout-ms=<n>        Per-probe timeout (default: 5000).

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createImageUrlValidator, formatProbeError } from "./lib/validate-image-url.mjs";

dotenv.config({ path: ".env.local" });

const DEFAULT_BATCH = 1000;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MS = 5_000;
// Only these statuses count as "permanently bad" — they're the signal the
// host is telling us the file is gone. 5xx / timeouts / 403 might be
// transient and shouldn't trigger a destructive update.
const PERMANENT_BAD_STATUSES = new Set([404, 410]);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const has = (flag) => args.includes(flag);
  const value = (prefix) => {
    const hit = args.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const parseInt10 = (raw, fallback) => {
    if (raw == null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const table = value("--table=") ?? "both";
  if (!["card_printings", "canonical_cards", "both"].includes(table)) {
    throw new Error(`--table must be card_printings, canonical_cards, or both`);
  }
  return {
    apply: has("--apply"),
    table,
    source: value("--source="),
    limit: parseInt10(value("--limit="), null),
    batch: parseInt10(value("--batch="), DEFAULT_BATCH),
    concurrency: parseInt10(value("--concurrency="), DEFAULT_CONCURRENCY),
    timeoutMs: parseInt10(value("--timeout-ms="), DEFAULT_TIMEOUT_MS),
  };
}

async function sweepCardPrintings(supabase, validator, opts, report) {
  let cursor = "";
  let scanned = 0;
  while (opts.limit == null || scanned < opts.limit) {
    const remaining = opts.limit == null ? opts.batch : Math.min(opts.batch, opts.limit - scanned);
    let query = supabase
      .from("card_printings")
      .select("id, image_url, source, image_mirror_last_error")
      .not("image_url", "is", null)
      .order("id", { ascending: true })
      .limit(remaining);
    if (cursor) query = query.gt("id", cursor);
    if (opts.source) query = query.eq("source", opts.source);

    const { data, error } = await query;
    if (error) throw new Error(`card_printings scan: ${error.message}`);
    if (!data || data.length === 0) break;

    scanned += data.length;
    cursor = data[data.length - 1].id;

    const probeResults = await validator.validateAll(data.map((row) => row.image_url));

    for (const row of data) {
      const probe = probeResults.get(row.image_url);
      if (!probe) continue;
      if (probe.ok) {
        report.okRows += 1;
        continue;
      }
      if (!PERMANENT_BAD_STATUSES.has(probe.status)) {
        report.skippedTransient += 1;
        continue;
      }
      report.badRows += 1;
      report.badByStatus[probe.status] = (report.badByStatus[probe.status] ?? 0) + 1;
      if (report.badSamples.length < 8) {
        report.badSamples.push({ id: row.id, source: row.source, url: row.image_url, status: probe.status });
      }
      if (opts.apply) {
        const { error: updateError } = await supabase
          .from("card_printings")
          .update({
            image_url: null,
            image_mirror_last_error: formatProbeError(row.image_url, probe),
          })
          .eq("id", row.id);
        if (updateError) {
          report.writeErrors += 1;
          console.error(`[card_printings] update ${row.id} failed: ${updateError.message}`);
        } else {
          report.writes += 1;
        }
      }
    }

    if (data.length < remaining) break;
  }
  report.scanned = scanned;
}

async function sweepCanonicalCards(supabase, validator, opts, report) {
  let cursor = "";
  let scanned = 0;
  while (opts.limit == null || scanned < opts.limit) {
    const remaining = opts.limit == null ? opts.batch : Math.min(opts.batch, opts.limit - scanned);
    let query = supabase
      .from("canonical_cards")
      .select("slug, primary_image_url, image_mirror_last_error")
      .not("primary_image_url", "is", null)
      .order("slug", { ascending: true })
      .limit(remaining);
    if (cursor) query = query.gt("slug", cursor);

    const { data, error } = await query;
    if (error) throw new Error(`canonical_cards scan: ${error.message}`);
    if (!data || data.length === 0) break;

    scanned += data.length;
    cursor = data[data.length - 1].slug;

    const probeResults = await validator.validateAll(data.map((row) => row.primary_image_url));

    for (const row of data) {
      const probe = probeResults.get(row.primary_image_url);
      if (!probe) continue;
      if (probe.ok) {
        report.okRows += 1;
        continue;
      }
      if (!PERMANENT_BAD_STATUSES.has(probe.status)) {
        report.skippedTransient += 1;
        continue;
      }
      report.badRows += 1;
      report.badByStatus[probe.status] = (report.badByStatus[probe.status] ?? 0) + 1;
      if (report.badSamples.length < 8) {
        report.badSamples.push({ slug: row.slug, url: row.primary_image_url, status: probe.status });
      }
      if (opts.apply) {
        const { error: updateError } = await supabase
          .from("canonical_cards")
          .update({
            primary_image_url: null,
            image_mirror_last_error: formatProbeError(row.primary_image_url, probe),
          })
          .eq("slug", row.slug);
        if (updateError) {
          report.writeErrors += 1;
          console.error(`[canonical_cards] update ${row.slug} failed: ${updateError.message}`);
        } else {
          report.writes += 1;
        }
      }
    }

    if (data.length < remaining) break;
  }
  report.scanned = scanned;
}

function blankReport() {
  return {
    scanned: 0,
    okRows: 0,
    badRows: 0,
    skippedTransient: 0,
    badByStatus: {},
    badSamples: [],
    writes: 0,
    writeErrors: 0,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const validator = createImageUrlValidator({
    concurrency: opts.concurrency,
    timeoutMs: opts.timeoutMs,
  });

  console.log(JSON.stringify({
    mode: opts.apply ? "APPLY" : "DRY_RUN",
    table: opts.table,
    source: opts.source,
    limit: opts.limit,
    batch: opts.batch,
    concurrency: opts.concurrency,
    timeoutMs: opts.timeoutMs,
    treatingAsBad: [...PERMANENT_BAD_STATUSES],
  }, null, 2));

  const printingsReport = blankReport();
  const canonicalReport = blankReport();

  if (opts.table === "card_printings" || opts.table === "both") {
    console.log("\n-- card_printings --");
    await sweepCardPrintings(supabase, validator, opts, printingsReport);
    console.log(JSON.stringify(printingsReport, null, 2));
  }

  if (opts.table === "canonical_cards" || opts.table === "both") {
    console.log("\n-- canonical_cards --");
    await sweepCanonicalCards(supabase, validator, opts, canonicalReport);
    console.log(JSON.stringify(canonicalReport, null, 2));
  }

  console.log("\n-- probe stats --");
  console.log(JSON.stringify(validator.stats(), null, 2));

  if (!opts.apply) {
    console.log("\nDry run. Re-run with --apply to write the updates above.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
