#!/usr/bin/env node
/**
 * backfill-card-translations
 *
 * Populates public.card_translations with EN <-> JP pairings via the
 * shared rule-based picker in lib/jp/translation-match.mjs. The picker
 * joins canonical_cards + card_printings against the verified rows in
 * public.set_pair_map and pairs by canonical_name equality within the
 * matched set pair. No embeddings, no thresholds.
 *
 * Prereq: run `node scripts/build-set-pair-map.mjs` first so the
 * set_pair_map table is populated. Without verified pairs there,
 * this script processes the catalog but writes zero rows.
 *
 * Usage:
 *   node scripts/backfill-card-translations.mjs
 *   node scripts/backfill-card-translations.mjs --slug=base-set-2-charizard
 *   node scripts/backfill-card-translations.mjs --limit=500 --dry-run
 *   node scripts/backfill-card-translations.mjs --resume-from=base-set-2-charizard
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  findPairBySetCode,
  PAIRING_SOURCE,
  PAIRING_CONFIDENCE,
  PAIRING_RANK,
} from "../lib/jp/translation-match.mjs";

dotenv.config({ path: ".env.local", override: true });

function parseArgs(argv) {
  const opts = { slug: null, limit: null, resumeFrom: null, dryRun: false, verbose: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--slug=")) opts.slug = arg.slice("--slug=".length);
    else if (arg.startsWith("--limit=")) opts.limit = Math.max(1, Number.parseInt(arg.slice("--limit=".length), 10) || 1);
    else if (arg.startsWith("--resume-from=")) opts.resumeFrom = arg.slice("--resume-from=".length);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: backfill-card-translations.mjs [--slug=X] [--limit=N] [--resume-from=SLUG] [--dry-run] [--verbose]");
      process.exit(0);
    }
  }
  return opts;
}

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) { console.error(`Missing ${name}`); process.exit(2); }
  return v;
}

function resolvePostgresUrl() {
  for (const n of ["POSTGRES_URL", "PopAlpha_POSTGRES_URL", "POPALPHA_POSTGRES_URL", "POSTGRES_URL_NON_POOLING"]) {
    const raw = process.env[n]?.trim().replace(/^["']|["']$/g, "");
    if (raw) { process.env.POSTGRES_URL = raw; return raw; }
  }
  console.error("No Postgres URL found in env");
  process.exit(2);
}

async function loadEnCandidates(supabase, opts) {
  if (opts.slug) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, language")
      .eq("slug", opts.slug)
      .limit(1);
    if (error) throw new Error(`canonical_cards: ${error.message}`);
    return (data ?? []).filter((r) => r.language === "EN").map((r) => ({ slug: r.slug }));
  }
  const PAGE = 1000;
  const rows = [];
  let cursor = opts.resumeFrom ?? null;
  while (true) {
    let q = supabase
      .from("canonical_cards")
      .select("slug")
      .eq("language", "EN")
      .order("slug", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt("slug", cursor);
    const { data, error } = await q;
    if (error) throw new Error(`canonical_cards page: ${error.message}`);
    const page = data ?? [];
    if (page.length === 0) break;
    rows.push(...page);
    cursor = page[page.length - 1].slug;
    if (opts.limit && rows.length >= opts.limit) return rows.slice(0, opts.limit);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function upsertPairing({ sql }, enSlug, jpSlug) {
  // Idempotency dance: drop any existing rows for this EN slug whose
  // JP target differs from the freshly-picked pair. Same pattern the
  // cron route uses; keeps the (en_slug, rank=0) lookup unique.
  await sql.query(
    `delete from card_translations where en_slug = $1 and jp_slug <> $2`,
    [enSlug, jpSlug],
  );
  const result = await sql.query(
    `
      insert into card_translations
        (en_slug, jp_slug, confidence, rank, source, updated_at)
      values ($1, $2, $3, $4, $5, now())
      on conflict (en_slug, jp_slug) do update
        set confidence = excluded.confidence,
            rank       = excluded.rank,
            source     = excluded.source,
            updated_at = now()
    `,
    [enSlug, jpSlug, PAIRING_CONFIDENCE, PAIRING_RANK, PAIRING_SOURCE],
  );
  return result.rowCount ?? 0;
}

async function main() {
  const opts = parseArgs(process.argv);
  resolvePostgresUrl();
  const { sql } = await import("@vercel/postgres");
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Surface set_pair_map readiness up front so the operator notices
  // if they forgot to run build-set-pair-map.mjs first.
  const { rows: spm } = await sql.query(
    `select count(*) filter (where verified) as verified, count(*) as total from set_pair_map`,
  );
  const verifiedPairs = Number(spm[0]?.verified ?? 0);
  const totalPairs = Number(spm[0]?.total ?? 0);
  console.log(`[backfill-card-translations] set_pair_map: ${verifiedPairs} verified / ${totalPairs} total`);
  if (verifiedPairs === 0) {
    console.error("[backfill-card-translations] No verified set pairs. Run scripts/build-set-pair-map.mjs first.");
    process.exit(1);
  }
  if (opts.dryRun) console.log("[backfill-card-translations] DRY RUN — no writes");

  const enCards = await loadEnCandidates(supabase, opts);
  console.log(`[backfill-card-translations] EN candidates: ${enCards.length}`);
  if (enCards.length === 0) { console.log("nothing to do — exiting"); return; }

  let processed = 0;
  let paired = 0;
  let noPair = 0;
  let noMatch = 0;
  let ambiguous = 0;
  let writtenRows = 0;
  let lastSlug = null;
  const attemptedSlugs = [];
  const started = Date.now();

  for (const enCard of enCards) {
    processed += 1;
    lastSlug = enCard.slug;
    if (!opts.dryRun) attemptedSlugs.push(enCard.slug);
    try {
      const result = await findPairBySetCode(sql, enCard.slug);
      if (result.kind === "paired") {
        paired += 1;
        if (opts.verbose || opts.dryRun) {
          console.log(`[${processed}] ${enCard.slug} -> ${result.jp_slug}  (${result.en_set_code} ↔ ${result.jp_set_code})`);
        }
        if (!opts.dryRun) {
          const rows = await upsertPairing({ sql }, enCard.slug, result.jp_slug);
          writtenRows += rows;
        }
      } else if (result.kind === "unpaired" && result.reason === "no_verified_set_pair") {
        noPair += 1;
        if (opts.verbose) console.log(`[${processed}] ${enCard.slug} — no verified set pair (en_set=${result.en_set_code ?? "?"})`);
      } else if (result.kind === "unpaired" && result.reason === "no_name_match") {
        noMatch += 1;
        if (opts.verbose) console.log(`[${processed}] ${enCard.slug} — paired set has no name match (${result.en_set_code} ↔ ${result.jp_set_code})`);
      } else if (result.kind === "ambiguous") {
        ambiguous += 1;
        if (opts.verbose) console.log(`[${processed}] ${enCard.slug} — AMBIGUOUS: ${result.jp_slugs.length} same-name JP candidates in ${result.jp_set_code}`);
      }
    } catch (err) {
      console.error(`[${processed}] ${enCard.slug} — ERROR: ${err?.message ?? err}`);
    }

    if (processed % 200 === 0) {
      const sec = (Date.now() - started) / 1000;
      const rate = processed / Math.max(0.1, sec);
      console.log(`[backfill-card-translations] ${processed}/${enCards.length}  paired=${paired} no_pair=${noPair} no_match=${noMatch} ambig=${ambiguous} wrote=${writtenRows}  ${rate.toFixed(1)} card/s`);
    }
  }

  // Stamp translation_attempted_at on processed slugs so the cron's
  // 14-day filter pushes them to the back of the queue.
  if (!opts.dryRun && attemptedSlugs.length > 0) {
    const stamp = await sql.query(
      `update canonical_cards set translation_attempted_at = now() where slug = any($1::text[])`,
      [attemptedSlugs],
    );
    console.log(`[backfill-card-translations] stamped translation_attempted_at on ${stamp.rowCount ?? 0} canonical_cards row(s)`);
  }

  const sec = (Date.now() - started) / 1000;
  console.log("");
  console.log(`[backfill-card-translations] DONE in ${sec.toFixed(1)}s`);
  console.log(`[backfill-card-translations] processed=${processed}  paired=${paired}  no_verified_set_pair=${noPair}  no_name_match=${noMatch}  ambiguous=${ambiguous}  rows_written=${writtenRows}`);
  console.log(`[backfill-card-translations] last_slug=${lastSlug}`);
}

main().catch((err) => {
  console.error("[backfill-card-translations] FATAL:", err?.stack ?? err);
  process.exit(1);
});
