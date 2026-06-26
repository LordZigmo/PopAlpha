#!/usr/bin/env node
// One-shot re-stamp of EN-RAW price history from Scrydex `low` -> `market`.
//
// Context: PR #310 (commit ede59fe) flipped the EN-RAW headline + chart
// price field from Scrydex `low` to Scrydex `market`, EN-only, FORWARD-ONLY.
// Existing historical `price_history_points` (source_window='snapshot',
// `::RAW` variant_refs, EN-language) still hold the old `low` values, so EN
// charts show a discontinuity at the merge date. This script renormalizes
// that history so the graphs read consistently on the market basis.
//
// Two cohorts, split at the observation-retention boundary (CUTOFF):
//
//   1. RE-STAMP (ts >= CUTOFF): we still have the observations, and every
//      EN-RAW observation stores Scrydex `market` in
//      metadata->>'scrydexAskingPriceUsd' (USD; populated on 100% of SCRYDEX
//      RAW obs). UPDATE each day's history points to that day's market.
//      Zero Scrydex credits — reads stored data only.
//
//   2. DELETE-STALE (ts < CUTOFF): the backing observations were pruned, so
//      no trustworthy market value exists. We DO NOT fabricate one (the
//      per-variant low->market ratio is unstable — that volatility is the
//      junk-listing noise the flip removes). We delete these EN-RAW snapshot
//      points so EN history starts cleanly at CUTOFF on the market basis,
//      with no internal low->market seam. (User-approved 2026-06-25.)
//
// Scope guards (EN-only, never touch JP/graded):
//   - `source_window='snapshot'` and `variant_ref LIKE '%::RAW'` (graded
//     refs end in ::PSA_G10 etc, so they're excluded).
//   - canonical_cards.language NULL or 'EN' (NULL is EN-managed per migration
//     20260612014500). JP RAW change columns are owned by
//     compute_jp_card_price_changes — explicitly excluded here.
//
// Idempotent + resumable: the re-stamp skips no-op rows
// (`price IS DISTINCT FROM`), and re-running re-applies the same market /
// re-deletes an already-empty cohort. Each statement auto-commits and is
// bounded (per-day UPDATE, ctid-batched DELETE) so it survives statement
// timeouts and can be stopped/restarted at any point.
//
// Run AFTER PR #310 is merged. ORDER OF OPERATIONS (see runbook in the PR):
//   restamp + delete-stale  ->  refresh card_metrics rollups for touched EN
//   slugs  ->  refresh_canonical_trusted_raw_prices.
//
// Usage:
//   node scripts/restamp-en-raw-history-market.mjs --dry-run
//   node scripts/restamp-en-raw-history-market.mjs --mode=restamp
//   node scripts/restamp-en-raw-history-market.mjs --mode=delete-stale
//   node scripts/restamp-en-raw-history-market.mjs --mode=all
//   (flags: --cutoff=YYYY-MM-DD  --batch=50000  --dry-run)
//
// Requires POSTGRES_URL pointing at Supabase prod (same connection the
// scan route uses). Falls back to building it from
// supabase/.temp/pooler-url + SUPABASE_DB_PASSWORD.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DRY_RUN = process.argv.includes("--dry-run");
const MODE = (process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "all").trim();
const CUTOFF = (process.argv.find((a) => a.startsWith("--cutoff="))?.split("=")[1] ?? "2026-05-31").trim();
const DELETE_BATCH = Number.parseInt(
  process.argv.find((a) => a.startsWith("--batch="))?.split("=")[1] ?? "50000",
  10,
);

if (!/^\d{4}-\d{2}-\d{2}$/.test(CUTOFF)) {
  console.error(`Invalid --cutoff (expected YYYY-MM-DD): ${CUTOFF}`);
  process.exit(2);
}
if (!["all", "restamp", "delete-stale"].includes(MODE)) {
  console.error(`Invalid --mode (expected all|restamp|delete-stale): ${MODE}`);
  process.exit(2);
}

function resolvePostgresUrl() {
  const direct = process.env.POSTGRES_URL?.trim().replace(/^["']|["']$/g, "");
  if (direct) {
    process.env.POSTGRES_URL = direct;
    return direct;
  }
  // Build from the linked-project pooler URL + DB password (the prod
  // long-ops path). pooler-url looks like:
  //   postgresql://postgres.<ref>:[YOUR-PASSWORD]@<host>:6543/postgres
  const poolerPath = path.join(ROOT, "supabase", ".temp", "pooler-url");
  const password = process.env.SUPABASE_DB_PASSWORD?.trim().replace(/^["']|["']$/g, "");
  if (fs.existsSync(poolerPath) && password) {
    const template = fs.readFileSync(poolerPath, "utf8").trim();
    const url = template.replace(/\[YOUR-PASSWORD\]|\[YOUR-PASSWORD-HERE\]/i, encodeURIComponent(password));
    if (url && !/\[YOUR-PASSWORD/i.test(url)) {
      process.env.POSTGRES_URL = url;
      return url;
    }
  }
  console.error(
    "No POSTGRES_URL. Set POSTGRES_URL to the Supabase prod connection string, " +
      "or provide SUPABASE_DB_PASSWORD with supabase/.temp/pooler-url present.",
  );
  process.exit(2);
}

// Filters shared by every statement so the three cohorts stay aligned.
// EN-managed = canonical_cards.language NULL or 'EN'.
const EN_RAW_SNAPSHOT_WHERE = `
  php.provider = 'SCRYDEX'
  and php.source_window = 'snapshot'
  and php.variant_ref like '%::RAW'
  and exists (
    select 1 from canonical_cards cc
    where cc.slug = php.canonical_slug
      and (cc.language is null or upper(cc.language) = 'EN')
  )
`;

async function countCohorts(sql) {
  const restamp = await sql.query(
    `select count(*)::bigint as n from price_history_points php
     where ${EN_RAW_SNAPSHOT_WHERE} and php.ts >= $1::date`,
    [CUTOFF],
  );
  const stale = await sql.query(
    `select count(*)::bigint as n from price_history_points php
     where ${EN_RAW_SNAPSHOT_WHERE} and php.ts < $1::date`,
    [CUTOFF],
  );
  // JP sanity: must be left untouched by everything here.
  const jp = await sql.query(
    `select count(*)::bigint as n from price_history_points php
     where php.provider = 'SCRYDEX' and php.source_window = 'snapshot'
       and php.variant_ref like '%::RAW'
       and exists (
         select 1 from canonical_cards cc
         where cc.slug = php.canonical_slug and upper(cc.language) = 'JP'
       )`,
  );
  return {
    restampCohort: Number(restamp.rows[0]?.n ?? 0),
    deleteCohort: Number(stale.rows[0]?.n ?? 0),
    jpUntouched: Number(jp.rows[0]?.n ?? 0),
  };
}

// One bounded UPDATE per UTC day. For each EN-RAW variant active that day,
// take the latest observation's Scrydex `market` (matching downsample's
// keep-latest semantics) and apply it to that day's snapshot history points.
async function restampDay(sql, day) {
  const result = await sql.query(
    `
    update price_history_points php
    set price = dm.market_usd, currency = 'USD'
    from (
      select distinct on (variant_ref)
        coalesce(nullif(pcm.printing_id::text, ''), pcm.canonical_slug)
          || '::' || o.provider_variant_id || '::RAW' as variant_ref,
        (o.metadata->>'scrydexAskingPriceUsd')::numeric as market_usd
      from provider_normalized_observations o
      join provider_card_map pcm
        on pcm.provider = 'SCRYDEX'
       and pcm.provider_key = o.provider_card_id || '::' || o.provider_variant_id
       and pcm.mapping_status = 'MATCHED'
       and pcm.canonical_slug is not null
      join canonical_cards cc on cc.slug = pcm.canonical_slug
      where o.provider = 'SCRYDEX'
        and o.metadata->>'grade' = 'RAW'
        and (o.metadata->>'scrydexAskingPriceUsd') is not null
        and (o.metadata->>'scrydexAskingPriceUsd')::numeric > 0
        and lower(o.normalized_condition) in ('nm', 'mint')
        and (cc.language is null or upper(cc.language) = 'EN')
        and o.observed_at >= $1::date and o.observed_at < ($1::date + 1)
      order by variant_ref, o.observed_at desc
    ) dm
    where php.provider = 'SCRYDEX'
      and php.source_window = 'snapshot'
      and php.variant_ref = dm.variant_ref
      and php.ts >= $1::date and php.ts < ($1::date + 1)
      and php.price is distinct from dm.market_usd
    `,
    [day],
  );
  return result.rowCount ?? 0;
}

// ctid-batched DELETE so each statement removes at most DELETE_BATCH rows and
// auto-commits — bounded regardless of how the stale cohort is distributed.
async function deleteStaleBatch(sql) {
  const result = await sql.query(
    `
    delete from price_history_points
    where ctid = any(array(
      select php.ctid
      from price_history_points php
      where ${EN_RAW_SNAPSHOT_WHERE} and php.ts < $1::date
      limit $2
    ))
    `,
    [CUTOFF, DELETE_BATCH],
  );
  return result.rowCount ?? 0;
}

function* eachUtcDay(fromIso, toIso) {
  const start = Date.UTC(
    Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)),
  );
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    yield new Date(t).toISOString().slice(0, 10);
  }
}

async function main() {
  resolvePostgresUrl();
  const { sql } = await import("@vercel/postgres");

  const counts = await countCohorts(sql);
  console.log(JSON.stringify({ phase: "cohorts", cutoff: CUTOFF, mode: MODE, ...counts }));

  if (DRY_RUN) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      wouldRestamp: ["all", "restamp"].includes(MODE) ? counts.restampCohort : 0,
      wouldDelete: ["all", "delete-stale"].includes(MODE) ? counts.deleteCohort : 0,
      jpUntouched: counts.jpUntouched,
    }, null, 2));
    return;
  }

  let totalRestamped = 0;
  let totalDeleted = 0;

  if (["all", "restamp"].includes(MODE)) {
    const today = new Date().toISOString().slice(0, 10);
    for (const day of eachUtcDay(CUTOFF, today)) {
      const n = await restampDay(sql, day);
      totalRestamped += n;
      console.log(JSON.stringify({ phase: "restamp", day, rowsUpdated: n, totalRestamped }));
    }
  }

  if (["all", "delete-stale"].includes(MODE)) {
    for (;;) {
      const n = await deleteStaleBatch(sql);
      totalDeleted += n;
      console.log(JSON.stringify({ phase: "delete-stale", rowsDeleted: n, totalDeleted }));
      if (n === 0) break;
    }
  }

  const after = await countCohorts(sql);
  console.log(JSON.stringify({
    ok: true,
    totalRestamped,
    totalDeleted,
    remaining: after,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
