#!/usr/bin/env node
/**
 * Step C of the Snkrdunk catalog-mapper sequence.
 *
 * Reads the JSONL produced by Step B (scripts/match-snkrdunk-canonical.mjs)
 * and upserts mapping rows into public.snkrdunk_product_map. Step D's
 * orchestrator then reads the MATCHED rows to know which Snkrdunk
 * products to fetch prices for.
 *
 * Status mapping (Step B's scorer → DB):
 *   "matched"        → mapping_status='MATCHED'         (auto-imported)
 *   "needs-review"   → mapping_status='NEEDS_REVIEW'    (gated for operator)
 *   "low-confidence" → skipped (don't pollute the table with rejects)
 *   "no-tc-results"  → skipped
 *   "no-query"       → skipped
 *   "search-failed"  → skipped (transient error; re-run Step B to retry)
 *
 * Idempotent: upserts on canonical_slug. Re-running with the same
 * JSONL is safe — existing rows get their score/reasons refreshed.
 *
 * Conflict handling: if the same Snkrdunk product code shows up for
 * two different canonical_slugs (a matcher bug), the unique constraint
 * on snkrdunk_product_code surfaces it as an INSERT error. We log the
 * conflict and skip — the operator inspects which mapping is correct.
 *
 * Usage:
 *   # Dry-run on the smoke-test JSONL
 *   node scripts/persist-snkrdunk-matches.mjs --input=/tmp/snkr-match-batch.jsonl --dry-run
 *
 *   # Real import (default reads the standard output path)
 *   node scripts/persist-snkrdunk-matches.mjs
 *
 *   # Include needs-review rows (default writes them too, gated by status)
 *   node scripts/persist-snkrdunk-matches.mjs --matched-only   # opt out of needs-review
 */

import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const DEFAULT_INPUT = "tmp/snkrdunk-canonical-matches.jsonl";

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    input: DEFAULT_INPUT,
    dryRun: false,
    matchedOnly: false,
    quiet: false,
  };
  for (const a of args) {
    if (a.startsWith("--input=")) opts.input = a.slice("--input=".length);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--matched-only") opts.matchedOnly = true;
    else if (a === "--quiet") opts.quiet = true;
  }
  return opts;
}

function statusToDb(status) {
  switch (status) {
    case "matched":
      return "MATCHED";
    case "needs-review":
      return "NEEDS_REVIEW";
    default:
      return null; // skip
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = (...args) => opts.quiet || console.log("[persist-snkrdunk]", ...args);

  const inputPath = resolve(opts.input);
  if (!existsSync(inputPath)) {
    console.error(`[persist-snkrdunk] input not found: ${inputPath}`);
    console.error("Run scripts/match-snkrdunk-canonical.mjs first to produce the JSONL.");
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rows = [];
  for (const line of readFileSync(inputPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      console.warn(`[persist-snkrdunk] skipping corrupt JSONL line: ${err.message}`);
    }
  }
  log(`loaded ${rows.length} JSONL row(s) from ${inputPath}`);

  let matched = 0;
  let needsReview = 0;
  let skipped = 0;
  let conflicts = 0;
  let writeErrors = 0;
  let written = 0;

  for (const row of rows) {
    const dbStatus = statusToDb(row.status);
    if (!dbStatus) {
      skipped += 1;
      continue;
    }
    if (opts.matchedOnly && dbStatus !== "MATCHED") {
      skipped += 1;
      continue;
    }
    if (!row.best) {
      // matched / needs-review without a best candidate shouldn't happen,
      // but guard anyway
      skipped += 1;
      continue;
    }

    const dbRow = {
      canonical_slug: row.canonical_slug,
      snkrdunk_id: row.best.snkrdunk_id,
      snkrdunk_product_code: row.best.snkrdunk_product_code,
      snkrdunk_name: row.best.name,
      mapping_status: dbStatus,
      match_score: row.best.score,
      match_reasons: Array.isArray(row.best.reasons) ? row.best.reasons : null,
      match_query: row.query ?? null,
      matched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (dbStatus === "MATCHED") matched += 1;
    if (dbStatus === "NEEDS_REVIEW") needsReview += 1;

    if (opts.dryRun) {
      log(`  [dry] ${dbStatus.padEnd(13)} ${dbRow.canonical_slug.slice(0, 50).padEnd(50)} → ${dbRow.snkrdunk_product_code}  score=${dbRow.match_score?.toFixed(2)}`);
      continue;
    }

    const { error } = await supabase
      .from("snkrdunk_product_map")
      .upsert(dbRow, { onConflict: "canonical_slug" });
    if (error) {
      // Most common write error: snkrdunk_product_code unique violation
      // (two canonicals matched to the same Snkrdunk product). Log + skip.
      if (error.code === "23505" || /unique/i.test(error.message)) {
        console.warn(`[persist-snkrdunk] CONFLICT for ${dbRow.canonical_slug} → ${dbRow.snkrdunk_product_code}: ${error.message}`);
        conflicts += 1;
        continue;
      }
      console.error(`[persist-snkrdunk] WRITE ERROR for ${dbRow.canonical_slug}: ${error.message}`);
      writeErrors += 1;
      continue;
    }
    written += 1;
  }

  console.log("");
  console.log("[persist-snkrdunk] DONE");
  console.log(`  loaded:       ${rows.length}`);
  console.log(`  matched:      ${matched}${opts.dryRun ? " (dry-run)" : ""}`);
  console.log(`  needs-review: ${needsReview}${opts.dryRun ? " (dry-run)" : ""}`);
  console.log(`  written:      ${written}${opts.dryRun ? " (dry-run skipped writes)" : ""}`);
  console.log(`  conflicts:    ${conflicts}`);
  console.log(`  write-errors: ${writeErrors}`);
  console.log(`  skipped:      ${skipped}`);

  if (writeErrors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[persist-snkrdunk] FATAL:", err);
  process.exit(1);
});
