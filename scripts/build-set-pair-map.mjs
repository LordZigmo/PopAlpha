#!/usr/bin/env node
/**
 * build-set-pair-map
 *
 * One-shot (re-runnable) builder for public.set_pair_map. For each
 * EN Scrydex set_code we have in card_printings, check whether the
 * `<id>_ja` candidate JP set has enough content overlap to count as
 * a real cross-language pair, and insert / update the row.
 *
 * Content overlap = fraction of EN cards in the set whose
 * canonical_name (case-insensitive) appears on a JP card in the
 * candidate JP set. Pairs >= AUTO_VERIFY_PCT (0.50) get marked
 * verified; everything else is logged for ops review and left
 * unverified so the picker won't trust it.
 *
 * Manual overrides (source='manual') are skipped by this script —
 * they're operator-curated and shouldn't be clobbered.
 *
 * Why a build step instead of computing overlap in the picker:
 *   - Overlap is a set-level property; per-card recomputation would
 *     redo the same scan ~thousand times per backfill run.
 *   - Operators can review the table directly and add overrides
 *     where the auto scan failed (Base Set 2 → Base Set, modern
 *     bundled-set cases).
 *
 * Usage:
 *   node scripts/build-set-pair-map.mjs              # full rebuild
 *   node scripts/build-set-pair-map.mjs --dry-run    # preview, no writes
 *   node scripts/build-set-pair-map.mjs --verbose
 */

import dotenv from "dotenv";

dotenv.config({ path: ".env.local", override: true });

const AUTO_VERIFY_PCT = 0.50;

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

function resolvePostgresUrl() {
  for (const n of ["POSTGRES_URL", "PopAlpha_POSTGRES_URL", "POPALPHA_POSTGRES_URL", "POSTGRES_URL_NON_POOLING"]) {
    const raw = process.env[n]?.trim().replace(/^["']|["']$/g, "");
    if (raw) { process.env.POSTGRES_URL = raw; return raw; }
  }
  console.error("No Postgres URL found in env");
  process.exit(2);
}

async function main() {
  const opts = parseArgs(process.argv);
  resolvePostgresUrl();
  const { sql } = await import("@vercel/postgres");

  console.log(`[build-set-pair-map] auto-verify threshold: name_match_pct >= ${AUTO_VERIFY_PCT}`);
  if (opts.dryRun) console.log("[build-set-pair-map] DRY RUN — no writes");

  // Single SQL query that returns, for every EN set_code with a candidate
  // <set>_ja JP counterpart, the counts we need to insert. Postgres is
  // happy to do this in one shot; doing it per-set in a JS loop would
  // round-trip the network ~50 times for no benefit.
  const { rows: pairs } = await sql.query(`
    with en_sets as (
      select distinct cp.set_code, cc.set_name
        from card_printings cp
        join canonical_cards cc on cc.slug = cp.canonical_slug
       where cc.language = 'EN'
         and cp.set_code is not null
    ),
    jp_sets as (
      select distinct cp.set_code, cc.set_name
        from card_printings cp
        join canonical_cards cc on cc.slug = cp.canonical_slug
       where cc.language = 'JP'
         and cp.set_code is not null
    ),
    candidates as (
      select e.set_code as en_set_code,
             e.set_name as en_set_name,
             e.set_code || '_ja' as jp_set_code,
             j.set_name as jp_set_name
        from en_sets e
        join jp_sets j on j.set_code = e.set_code || '_ja'
    )
    select c.en_set_code,
           c.en_set_name,
           c.jp_set_code,
           c.jp_set_name,
           (select count(distinct cc.slug)
              from canonical_cards cc
              join card_printings cp on cp.canonical_slug = cc.slug
             where cc.language = 'EN' and cp.set_code = c.en_set_code) as en_card_count,
           (select count(distinct cc.slug)
              from canonical_cards cc
              join card_printings cp on cp.canonical_slug = cc.slug
             where cc.language = 'JP' and cp.set_code = c.jp_set_code) as jp_card_count,
           (select count(distinct cc1.slug)
              from canonical_cards cc1
              join card_printings cp1 on cp1.canonical_slug = cc1.slug
             where cc1.language = 'EN' and cp1.set_code = c.en_set_code
               and exists (
                 select 1 from canonical_cards cc2
                 join card_printings cp2 on cp2.canonical_slug = cc2.slug
                 where cc2.language = 'JP' and cp2.set_code = c.jp_set_code
                   and lower(trim(cc2.canonical_name)) = lower(trim(cc1.canonical_name))
               )) as name_match_count
      from candidates c
     order by c.en_set_code
  `);

  console.log(`[build-set-pair-map] inspected ${pairs.length} candidate pair(s)`);

  let verifiedCount = 0;
  let rejectedCount = 0;
  let inserted = 0;
  let updated = 0;
  let skippedManual = 0;

  for (const row of pairs) {
    const enCardCount = Number(row.en_card_count ?? 0);
    const nameMatchCount = Number(row.name_match_count ?? 0);
    const pct = enCardCount > 0 ? nameMatchCount / enCardCount : 0;
    const isVerified = pct >= AUTO_VERIFY_PCT;
    if (isVerified) verifiedCount += 1; else rejectedCount += 1;

    const tag = isVerified ? "OK " : "lo ";
    if (opts.verbose || !isVerified) {
      console.log(
        `  [${tag}] ${row.en_set_code.padEnd(12)} -> ${row.jp_set_code.padEnd(15)} ` +
        `pct=${pct.toFixed(2)} (${nameMatchCount}/${enCardCount})  ` +
        `${row.en_set_name ?? ""} / ${row.jp_set_name ?? ""}`,
      );
    }

    if (opts.dryRun) continue;

    // Don't clobber manual overrides — operators have curated those.
    const existing = await sql.query(
      `select source from set_pair_map where en_set_code = $1`,
      [row.en_set_code],
    );
    if (existing.rows[0]?.source === "manual") {
      skippedManual += 1;
      if (opts.verbose) console.log(`        skipped: existing row has source=manual`);
      continue;
    }

    const result = await sql.query(
      `
        insert into set_pair_map
          (en_set_code, jp_set_code, en_set_name, jp_set_name,
           en_card_count, jp_card_count, name_match_count, name_match_pct,
           verified, source, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'auto', now())
        on conflict (en_set_code) do update
          set jp_set_code      = excluded.jp_set_code,
              en_set_name      = excluded.en_set_name,
              jp_set_name      = excluded.jp_set_name,
              en_card_count    = excluded.en_card_count,
              jp_card_count    = excluded.jp_card_count,
              name_match_count = excluded.name_match_count,
              name_match_pct   = excluded.name_match_pct,
              verified         = excluded.verified,
              -- Preserve source/override_reason — manual rows already
              -- short-circuit above; this branch is only reached for
              -- existing auto rows being refreshed.
              source           = 'auto',
              updated_at       = now()
        returning xmax = 0 as inserted
      `,
      [
        row.en_set_code,
        row.jp_set_code,
        row.en_set_name,
        row.jp_set_name,
        enCardCount,
        Number(row.jp_card_count ?? 0),
        nameMatchCount,
        pct,
        isVerified,
      ],
    );
    if (result.rows[0]?.inserted) inserted += 1; else updated += 1;
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
