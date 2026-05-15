#!/usr/bin/env node
/**
 * One-off cleanup: re-classify the 316 snkrdunk_product_map rows whose
 * setCode wasn't covered by `setCodeEra` in scripts/match-snkrdunk-canonical.mjs
 * at the time the matcher ran.
 *
 * After PR #72 expanded setCodeEra, the era audit re-ran on the broad
 * map and promoted 1,189 NEEDS_REVIEW → MATCHED + rejected 187 wrong-era
 * matches. But 316 rows kept their pre-audit status because their
 * setCode wasn't in the (already-expanded) map either — these are the
 * 34 unmapped codes surveyed below.
 *
 * Era windows for the unmapped codes were determined by parsing the
 * Snkrdunk set names (which include the human-readable set name) and
 * mapping each set to its Pokemon TCG release year. Sources of truth:
 *   - The Snkrdunk product name itself (e.g. "Premium Champion Pack
 *     EX x M x BREAK" → XY era, 2016)
 *   - Bulbapedia for ambiguous cases (e.g. "Pokemon Card Web")
 *
 * Logic:
 *   1. Read each MATCHED + NEEDS_REVIEW row.
 *   2. Extract setCode from snkrdunk_name (regex: \[([^ ]+) [0-9]).
 *   3. Look up era window in EXTENDED_ERA_MAP (the existing setCodeEra
 *      function + the 34 new codes).
 *   4. Pull canonical_cards.year for the canonical_slug.
 *   5. Decision:
 *      - era unknown OR year null → keep current status (can't decide)
 *      - year in [yMin-3, yMax+3] → if NEEDS_REVIEW, promote to MATCHED
 *      - year outside → mark REJECTED (with reviewed_by='era-audit-2026-05-15-followup')
 *
 * Idempotent: a second run sees the new statuses and skips no-op rows.
 * Read-only by default; pass --apply to write changes.
 *
 * Usage:
 *   node --env-file=.env.local scripts/snkrdunk-era-audit-cleanup.mjs
 *   node --env-file=.env.local scripts/snkrdunk-era-audit-cleanup.mjs --apply
 */

import { createClient } from "@supabase/supabase-js";
import { setCodeEra as baseSetCodeEra } from "./match-snkrdunk-canonical.mjs";

const APPLY = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Era windows for setCodes the matcher's setCodeEra() doesn't cover.
// Discovered via the post-PR-72 era audit (2026-05-15). Mostly:
//   - MEGA-era setCodes that the /^M[123]/ pattern missed: M4, M-P, MA,
//     MBG (2025-2026)
//   - Concept Packs CP2-CP6 + EBB + SC (XY era reprints, 2013-2016)
//   - Vintage series setCodes: VS / web / neoI / e / eP / P (1999-2003)
//   - Misc one-offs (HS, HS+, HSP, WAK, B, BK, SP4, SA, SLD, CLL, CLK, M)
const EXTENDED_ERA_OVERRIDES = {
  // MEGA era (2025-2026)
  M4: [2026, 2026],
  "M-P": [2025, 2026],
  MA: [2025, 2026],
  MBG: [2025, 2026],

  // SWSH-era stragglers
  SP4: [2021, 2022],
  SA: [2020, 2022],
  SLD: [2022, 2022],

  // XY-era Concept / Premium / EX Battle packs
  CP2: [2015, 2015],
  CP3: [2015, 2015],
  CP4: [2016, 2016],
  CP5: [2016, 2016],
  CP6: [2016, 2016],
  EBB: [2014, 2014],
  SC: [2013, 2013],

  // BW / HGSS era one-offs
  WAK: [2012, 2012],
  B: [2010, 2011],
  BK: [2011, 2012],
  HSP: [2010, 2011],
  HS: [2010, 2011],
  "HS+": [2010, 2011],

  // DP-era random pack
  M: [2009, 2010],

  // Vintage 1999-2003
  neoI: [1999, 2000],
  eP: [2001, 2003],
  e: [2001, 2003],
  VS: [2001, 2001],
  web: [2001, 2001],
  P: [1999, 2001],

  // 2023+ Classic reprint sets
  CLL: [2023, 2023],
  CLK: [2023, 2023],
};

function eraFor(code) {
  if (!code) return null;
  const exact = EXTENDED_ERA_OVERRIDES[code];
  if (exact) return exact;
  return baseSetCodeEra(code);
}

function classify(year, era) {
  if (year == null) return "year_null";
  if (era == null) return "era_unknown";
  const [yMin, yMax] = era;
  if (year >= yMin - 3 && year <= yMax + 3) return "era_match";
  return "era_mismatch";
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (writes to DB)" : "DRY RUN (read-only)"}`);
  console.log();

  // Load all MATCHED + NEEDS_REVIEW rows
  const PAGE = 1000;
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("snkrdunk_product_map")
      .select("id, canonical_slug, snkrdunk_name, mapping_status, match_score")
      .in("mapping_status", ["MATCHED", "NEEDS_REVIEW"])
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Loaded ${all.length} MATCHED + NEEDS_REVIEW rows`);

  // Look up canonical.year for all distinct slugs
  const slugs = [...new Set(all.map((r) => r.canonical_slug).filter(Boolean))];
  const yearBySlug = new Map();
  const SLUG_PAGE = 150;
  for (let i = 0; i < slugs.length; i += SLUG_PAGE) {
    const batch = slugs.slice(i, i + SLUG_PAGE);
    const { data, error } = await sb.from("canonical_cards").select("slug, year").in("slug", batch);
    if (error) throw error;
    for (const r of data ?? []) yearBySlug.set(r.slug, r.year);
  }
  console.log(`Loaded year for ${yearBySlug.size}/${slugs.length} canonical slugs`);

  // Decide per row
  const stats = { era_match: 0, era_mismatch: 0, era_unknown: 0, year_null: 0 };
  const txByStatus = {};
  const toPromote = [];
  const toReject = [];
  for (const r of all) {
    const m = (r.snkrdunk_name || "").match(/\[([^ ]+) [0-9]/);
    const code = m ? m[1] : null;
    const era = eraFor(code);
    const year = yearBySlug.get(r.canonical_slug);
    const verdict = classify(year, era);
    stats[verdict]++;
    const tk = `${r.mapping_status}→${verdict}`;
    txByStatus[tk] = (txByStatus[tk] || 0) + 1;

    if (r.mapping_status === "NEEDS_REVIEW" && verdict === "era_match") toPromote.push(r);
    if (
      (r.mapping_status === "MATCHED" || r.mapping_status === "NEEDS_REVIEW") &&
      verdict === "era_mismatch"
    ) {
      toReject.push({ ...r, year, era });
    }
  }

  console.log();
  console.log("Verdict distribution:");
  for (const [k, v] of Object.entries(stats)) console.log("  " + k.padEnd(14), v);
  console.log();
  console.log("Status transitions:");
  for (const [k, v] of Object.entries(txByStatus).sort((a, b) => b[1] - a[1])) {
    console.log("  " + k.padEnd(35), v);
  }
  console.log();
  console.log(`Would promote (NEEDS_REVIEW → MATCHED): ${toPromote.length}`);
  console.log(`Would reject  (MATCHED → REJECTED)   : ${toReject.length}`);

  if (toReject.length > 0) {
    console.log();
    console.log("Sample rejections:");
    for (const r of toReject.slice(0, 10)) {
      console.log(
        `  ${r.canonical_slug.padEnd(45)} year=${r.year} era=[${r.era?.join("-")}] ${r.snkrdunk_name.slice(0, 80)}`,
      );
    }
  }

  if (!APPLY) {
    console.log();
    console.log("(dry-run; pass --apply to write)");
    return;
  }

  if (toPromote.length > 0) {
    console.log();
    console.log(`Promoting ${toPromote.length} rows to MATCHED...`);
    const promoteIds = toPromote.map((r) => r.id);
    for (let i = 0; i < promoteIds.length; i += 200) {
      const batch = promoteIds.slice(i, i + 200);
      const { error } = await sb
        .from("snkrdunk_product_map")
        .update({
          mapping_status: "MATCHED",
          reviewed_at: new Date().toISOString(),
          reviewed_by: "era-audit-2026-05-15-followup",
        })
        .in("id", batch);
      if (error) throw error;
      console.log(`  promoted batch ${i + batch.length}/${promoteIds.length}`);
    }
  }

  if (toReject.length > 0) {
    console.log();
    console.log(`Rejecting ${toReject.length} rows...`);
    const rejectIds = toReject.map((r) => r.id);
    for (let i = 0; i < rejectIds.length; i += 200) {
      const batch = rejectIds.slice(i, i + 200);
      const { error } = await sb
        .from("snkrdunk_product_map")
        .update({
          mapping_status: "REJECTED",
          reviewed_at: new Date().toISOString(),
          reviewed_by: "era-audit-2026-05-15-followup",
        })
        .in("id", batch);
      if (error) throw error;
      console.log(`  rejected batch ${i + batch.length}/${rejectIds.length}`);
    }
  }

  // Final state
  console.log();
  for (const status of ["MATCHED", "NEEDS_REVIEW", "REJECTED"]) {
    const { count } = await sb
      .from("snkrdunk_product_map")
      .select("*", { count: "exact", head: true })
      .eq("mapping_status", status);
    console.log(`  ${status.padEnd(14)} ${count}`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
