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
//      Driven per-UTC-day by observations (the obs (provider, observed_at)
//      index + the price_history_points unique index on
//      (provider, variant_ref, ts, source_window) keep each day bounded).
//      Zero Scrydex credits — reads stored data only.
//
//   2. DELETE-STALE (ts < CUTOFF): the backing observations were pruned, so
//      no trustworthy market value exists. We DO NOT fabricate one (the
//      per-variant low->market ratio is unstable — that volatility is the
//      junk-listing noise the flip removes). We delete these EN-RAW snapshot
//      points so EN history starts cleanly at CUTOFF on the market basis,
//      with no internal low->market seam. (User-approved 2026-06-25.)
//      Driven by canonical_slug CHUNKS (not the whole table): the
//      `variant_ref LIKE` predicates are NOT sargable, so a table-wide filter
//      seq-scans all ~7M rows (~15 min) — fatal for a per-batch loop. Instead
//      we page EN slugs from canonical_cards (OFFSET/LIMIT, small table) and
//      operate on each chunk's rows via the (canonical_slug, ts) index, so
//      the LIKE only ever touches a handful of rows per slug (~40s/chunk).
//
// Scope guards (EN-only, never touch JP/graded):
//   - `source_window='snapshot'`, `variant_ref LIKE '%::RAW'` AND
//     `variant_ref NOT LIKE '%::GRADED::%'`. NOTE: graded snapshot refs ALSO
//     end in `::RAW` (the grade is encoded earlier, as
//     `...::GRADED::PSA::G10::RAW`), so the `::RAW` suffix alone is NOT
//     raw-only — the `::GRADED::` exclusion is what makes it raw-only.
//   - EN-managed slugs = canonical_cards.language NULL or 'EN' (NULL is
//     EN-managed per migration 20260612014500). JP RAW change columns are
//     owned by compute_jp_card_price_changes — excluded by paging only EN
//     slugs AND (defense in depth) the language guard in each statement.
//
// Idempotent + resumable: the re-stamp skips no-op rows
// (`price IS DISTINCT FROM`), and re-running re-applies the same market /
// re-deletes an already-empty cohort. Every statement auto-commits (psql -c)
// and is bounded (per-day UPDATE, per-slug-chunk DELETE) so it survives
// statement timeouts and can be stopped/restarted at any point. `SET
// statement_timeout=0` is prepended as a safety margin for an occasional slow
// day/chunk; it is NOT a license for unbounded work — bounding comes from the
// per-day / per-chunk scoping.
//
// Transport: psql against the Supabase pooler (the proven prod long-ops
// path). @vercel/postgres is NOT usable here — it bundles the Neon
// serverless WebSocket driver, which cannot speak to the Supabase pooler.
//
// Run AFTER PR #310 is merged. ORDER OF OPERATIONS (see runbook in the PR):
//   restamp + delete-stale  ->  refresh card_metrics rollups for touched EN
//   slugs  ->  refresh_canonical_trusted_raw_prices.
//
// Usage (from the repo root, with .env.local providing SUPABASE_DB_PASSWORD
// and supabase/.temp/pooler-url present):
//   npm run restamp:en-raw-history -- --dry-run
//   npm run restamp:en-raw-history -- --mode=restamp
//   npm run restamp:en-raw-history -- --mode=delete-stale
//   npm run restamp:en-raw-history -- --mode=all
//   (flags: --cutoff=YYYY-MM-DD  --chunk=1000  --dry-run)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DRY_RUN = process.argv.includes("--dry-run");
const MODE = (process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "all").trim();
const CUTOFF = (process.argv.find((a) => a.startsWith("--cutoff="))?.split("=")[1] ?? "2026-05-31").trim();
const SLUG_CHUNK = Number.parseInt(
  process.argv.find((a) => a.startsWith("--chunk="))?.split("=")[1] ?? "1000",
  10,
);

// CUTOFF is interpolated into SQL, so it MUST be a strict date literal.
if (!/^\d{4}-\d{2}-\d{2}$/.test(CUTOFF)) {
  console.error(`Invalid --cutoff (expected YYYY-MM-DD): ${CUTOFF}`);
  process.exit(2);
}
if (!Number.isInteger(SLUG_CHUNK) || SLUG_CHUNK <= 0 || SLUG_CHUNK > 20000) {
  console.error(`Invalid --chunk (expected positive integer <= 20000): ${SLUG_CHUNK}`);
  process.exit(2);
}
if (!["all", "restamp", "delete-stale"].includes(MODE)) {
  console.error(`Invalid --mode (expected all|restamp|delete-stale): ${MODE}`);
  process.exit(2);
}

// Resolve the psql connection. This is the established prod long-ops path
// (psql + supabase/.temp/pooler-url + SUPABASE_DB_PASSWORD). Two constraints
// pull in opposite directions, so we satisfy both:
//   - The password must NOT appear in psql's argv (visible via `ps`), so it
//     goes out-of-band via PGPASSWORD, never on the URL.
//   - libpq falls back to PGPASSWORD ONLY when the URI carries no password
//     component — and the standard linked pooler-url ships a `[YOUR-PASSWORD]`
//     placeholder, which would otherwise (mis)authenticate as the literal
//     placeholder. So we STRIP any password/placeholder off the URI.
// Net: a password-free URI in argv + the real secret in PGPASSWORD.
function resolvePsqlConnection() {
  const poolerPath = path.join(ROOT, "supabase", ".temp", "pooler-url");
  const raw = process.env.POSTGRES_URL?.trim().replace(/^["']|["']$/g, "")
    || (fs.existsSync(poolerPath) ? fs.readFileSync(poolerPath, "utf8").trim() : "");
  const password = process.env.SUPABASE_DB_PASSWORD?.trim().replace(/^["']|["']$/g, "");
  if (!raw) {
    console.error("No connection URL. Set POSTGRES_URL or provide supabase/.temp/pooler-url.");
    process.exit(2);
  }
  if (!password) {
    console.error("Missing SUPABASE_DB_PASSWORD (needed for the pooler login).");
    process.exit(2);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error("Connection URL is not a valid URI.");
    process.exit(2);
  }
  url.password = "";
  return { url: url.toString(), password };
}

const CONN = resolvePsqlConnection();
const CONN_URL = CONN.url;
const PSQL_ENV = { ...process.env, PGPASSWORD: CONN.password, PGCONNECT_TIMEOUT: "20" };

// Run a single SQL statement via psql and return its first scalar as a Number.
// `-tAX`: tuples-only, unaligned, no .psqlrc. ON_ERROR_STOP surfaces SQL
// errors as a non-zero exit. SQL passed as one argv (no shell) so quotes/`%`
// are safe. `set statement_timeout=0` prepended as a per-session safety
// margin (each psql -c is its own session).
function runScalar(text) {
  const out = execFileSync(
    "psql",
    [CONN_URL, "-tAX", "-v", "ON_ERROR_STOP=1", "-c", `set statement_timeout=0; ${text}`],
    { env: PSQL_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // Skip the "SET" command tag; take the last non-empty scalar line.
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "SET");
  const n = Number(lines.at(-1));
  return Number.isFinite(n) ? n : 0;
}

// The SCRYDEX raw-only / graded-excluded snapshot predicate (see GRADED
// GOTCHA above). The `provider = 'SCRYDEX'` scope is REQUIRED here, not just
// in the mutations: other providers (JUSTTCG, POKEMON_TCG_API, JP feeds) also
// build `::RAW` snapshot refs, so without it the dry-run counts would include
// rows the restamp/delete never touch.
const RAW_SNAPSHOT = `php.provider = 'SCRYDEX'
  and php.source_window = 'snapshot'
  and php.variant_ref like '%::RAW'
  and php.variant_ref not like '%::GRADED::%'`;

// EN-slug page subquery: stable order, paged from the small canonical_cards
// table. EN-managed = language NULL or 'EN'.
function enSlugPage(offset) {
  return `array(
    select slug from canonical_cards
    where (language is null or upper(language) = 'EN')
    order by slug offset ${offset} limit ${SLUG_CHUNK}
  )`;
}

function enSlugCount() {
  return runScalar(
    `select count(*)::bigint from canonical_cards where (language is null or upper(language) = 'EN')`,
  );
}

// Count both cohorts for one EN-slug chunk via the (canonical_slug, ts) index.
function countChunk(offset) {
  const out = execFileSync(
    "psql",
    [CONN_URL, "-tAXF", "|", "-v", "ON_ERROR_STOP=1", "-c",
      `set statement_timeout=0;
       select
         count(*) filter (where php.ts >= date '${CUTOFF}'),
         count(*) filter (where php.ts < date '${CUTOFF}')
       from price_history_points php
       where php.canonical_slug = any(${enSlugPage(offset)})
         and ${RAW_SNAPSHOT}`],
    { env: PSQL_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const row = out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "SET").at(-1) ?? "0|0";
  const [restamp, del] = row.split("|").map((v) => Number(v) || 0);
  return { restamp, del };
}

function countCohorts() {
  const total = enSlugCount();
  let restampCohort = 0;
  let deleteCohort = 0;
  for (let offset = 0; offset < total; offset += SLUG_CHUNK) {
    const { restamp, del } = countChunk(offset);
    restampCohort += restamp;
    deleteCohort += del;
    console.log(JSON.stringify({ phase: "count", offset, restampCohort, deleteCohort }));
  }
  return { restampCohort, deleteCohort, enSlugs: total };
}

// One bounded UPDATE per UTC day. For each EN-RAW variant active that day,
// take the latest observation's Scrydex `market` (matching downsample's
// keep-latest semantics) and apply it to that day's snapshot history points.
// Graded-safe by construction: `dm` is built only from grade='RAW'
// observations, so dm.variant_ref never contains `::GRADED::`, and the
// `php.variant_ref = dm.variant_ref` exact match can only hit true-raw rows.
function restampDay(day) {
  return runScalar(
    `
    with upd as (
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
          and o.observed_at >= date '${day}' and o.observed_at < (date '${day}' + 1)
        order by variant_ref, o.observed_at desc
      ) dm
      where php.provider = 'SCRYDEX'
        and php.source_window = 'snapshot'
        and php.variant_ref = dm.variant_ref
        and php.ts >= date '${day}' and php.ts < (date '${day}' + 1)
        and php.price is distinct from dm.market_usd
      returning 1
    )
    select count(*)::bigint from upd
    `,
  );
}

// DELETE one EN-slug chunk's pre-cutoff true-raw snapshot points, driven by
// the (canonical_slug, ts) index so the LIKE only touches each slug's rows.
// The language guard is redundant with the EN-only paging but kept as defense
// in depth so a stray non-EN slug can never be deleted.
function deleteSlugChunk(offset) {
  return runScalar(
    `
    with del as (
      delete from price_history_points php
      using canonical_cards cc
      where cc.slug = php.canonical_slug
        and (cc.language is null or upper(cc.language) = 'EN')
        and php.canonical_slug = any(${enSlugPage(offset)})
        and ${RAW_SNAPSHOT}
        and php.ts < date '${CUTOFF}'
      returning 1
    )
    select count(*)::bigint from del
    `,
  );
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

function main() {
  if (DRY_RUN) {
    const counts = countCohorts();
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      cutoff: CUTOFF,
      mode: MODE,
      wouldRestamp: ["all", "restamp"].includes(MODE) ? counts.restampCohort : 0,
      wouldDelete: ["all", "delete-stale"].includes(MODE) ? counts.deleteCohort : 0,
      enSlugs: counts.enSlugs,
    }, null, 2));
    return;
  }

  let totalRestamped = 0;
  let totalDeleted = 0;

  if (["all", "restamp"].includes(MODE)) {
    const today = new Date().toISOString().slice(0, 10);
    for (const day of eachUtcDay(CUTOFF, today)) {
      const n = restampDay(day);
      totalRestamped += n;
      console.log(JSON.stringify({ phase: "restamp", day, rowsUpdated: n, totalRestamped }));
    }
  }

  if (["all", "delete-stale"].includes(MODE)) {
    const total = enSlugCount();
    for (let offset = 0; offset < total; offset += SLUG_CHUNK) {
      const n = deleteSlugChunk(offset);
      totalDeleted += n;
      console.log(JSON.stringify({ phase: "delete-stale", offset, rowsDeleted: n, totalDeleted }));
    }
  }

  console.log(JSON.stringify({ ok: true, mode: MODE, cutoff: CUTOFF, totalRestamped, totalDeleted }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(String(error?.stderr ?? error?.stack ?? error));
  process.exit(1);
}
