#!/usr/bin/env node
/**
 * build-set-pair-map
 *
 * One-shot (re-runnable) builder for public.set_pair_map. For each
 * EN Scrydex set_code we have in card_printings, check whether the
 * `<id>_ja` candidate JP set has enough content overlap to count as
 * a real cross-language pair, and insert / update the row.
 *
 * Manual overrides (source='manual') are skipped by this script;
 * they're operator-curated and shouldn't be clobbered.
 *
 * Usage:
 *   node scripts/build-set-pair-map.mjs              # full rebuild
 *   node scripts/build-set-pair-map.mjs --dry-run    # preview, no writes
 *   node scripts/build-set-pair-map.mjs --verbose
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  loadCanonicalCardsForPairing,
  loadCardPrintingsForPairing,
  loadSetPairMapForPairing,
} from "../lib/jp/pairing-catalog.mjs";
import {
  AUTO_VERIFY_PCT,
  buildSetPairMapRows,
} from "../lib/jp/set-pair-map.mjs";

dotenv.config({ path: ".env.local" });

const UPSERT_CHUNK_SIZE = 500;

function parseArgs(argv) {
  const opts = { dryRun: false, verbose: false };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: build-set-pair-map.mjs [--dry-run] [--verbose]");
      process.exit(0);
    }
  }
  return opts;
}

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return v;
}

function createSupabaseServiceClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

async function main() {
  const opts = parseArgs(process.argv);
  const supabase = createSupabaseServiceClient();

  console.log(`[build-set-pair-map] auto-verify threshold: name_match_pct >= ${AUTO_VERIFY_PCT}`);
  if (opts.dryRun) console.log("[build-set-pair-map] DRY RUN - no writes");

  const [canonicalCards, cardPrintings, existingPairs] = await Promise.all([
    loadCanonicalCardsForPairing(supabase),
    loadCardPrintingsForPairing(supabase),
    loadSetPairMapForPairing(supabase),
  ]);

  const existingByEnSetCode = new Map(existingPairs.map((row) => [row.en_set_code, row]));
  const pairs = buildSetPairMapRows({ canonicalCards, cardPrintings });

  console.log(`[build-set-pair-map] inspected ${pairs.length} candidate pair(s)`);

  let verifiedCount = 0;
  let rejectedCount = 0;
  let inserted = 0;
  let updated = 0;
  let skippedManual = 0;
  const writes = [];
  const now = new Date().toISOString();

  for (const row of pairs) {
    if (row.verified) verifiedCount += 1;
    else rejectedCount += 1;

    const tag = row.verified ? "OK " : "lo ";
    if (opts.verbose || !row.verified) {
      console.log(
        `  [${tag}] ${row.en_set_code.padEnd(12)} -> ${row.jp_set_code.padEnd(15)} ` +
        `pct=${row.name_match_pct.toFixed(2)} (${row.name_match_count}/${row.en_card_count})  ` +
        `${row.en_set_name ?? ""} / ${row.jp_set_name ?? ""}`,
      );
    }

    if (opts.dryRun) continue;

    const existing = existingByEnSetCode.get(row.en_set_code);
    if (existing?.source === "manual") {
      skippedManual += 1;
      if (opts.verbose) console.log("        skipped: existing row has source=manual");
      continue;
    }

    if (existing) updated += 1;
    else inserted += 1;
    writes.push({ ...row, updated_at: now });
  }

  for (const chunk of chunkRows(writes, UPSERT_CHUNK_SIZE)) {
    const { error } = await supabase
      .from("set_pair_map")
      .upsert(chunk, { onConflict: "en_set_code" });
    if (error) throw new Error(`set_pair_map upsert: ${error.message}`);
  }

  console.log("");
  console.log(`[build-set-pair-map] verified pairs:   ${verifiedCount}`);
  console.log(`[build-set-pair-map] rejected (<${AUTO_VERIFY_PCT}): ${rejectedCount}`);
  if (!opts.dryRun) {
    console.log(`[build-set-pair-map] rows inserted:    ${inserted}`);
    console.log(`[build-set-pair-map] rows updated:     ${updated}`);
    console.log(`[build-set-pair-map] manual rows kept: ${skippedManual}`);
  }
}

main().catch((e) => {
  console.error("[build-set-pair-map] FATAL:", e?.stack ?? e);
  process.exit(1);
});
