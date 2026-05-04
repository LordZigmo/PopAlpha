#!/usr/bin/env node
// scripts/stress-reliability-audit.mjs
//
// Reliability scorecard for homepage rails + Pokemon pricing freshness.
// Read-only: SELECTs only, no cron triggers, no writes.
//
// Modes:
//   --rehearsal       Validate every probe via EXPLAIN against the linked DB
//                     schema. No row data is graded; only that queries compile.
//   (default)         Full audit. Each probe runs, results graded against
//                     thresholds defined inline. Prints a scorecard.
//   --http            Add Layer 2 (public HTTP probes against APP_URL) and
//                     Layer 3 (the existing /api/debug/pipeline-health endpoint).
//   --db-only         Skip HTTP probes even when --http is implied elsewhere.
//   --json            Emit final JSON only (machine-readable). Default human.
//   --verbose         Print SQL on failures.
//
// Auth:
//   - DB: uses `supabase db query --linked`. No SUPABASE_DB_PASSWORD needed;
//     CLI session auth handles it (`supabase login` + `supabase link`).
//   - HTTP: CRON_SECRET from env for /api/debug/pipeline-health. Public
//     endpoints need no auth.
//
// Usage:
//   node --env-file=.env.local scripts/stress-reliability-audit.mjs --rehearsal
//   node --env-file=.env.local scripts/stress-reliability-audit.mjs --http

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ARGS = new Set(process.argv.slice(2));
const REHEARSAL = ARGS.has("--rehearsal");
const HTTP_MODE = ARGS.has("--http");
const DB_ONLY = ARGS.has("--db-only");
const JSON_OUT = ARGS.has("--json");
const VERBOSE = ARGS.has("--verbose");

const APP_URL = (process.env.APP_URL ?? "https://popalpha.ai").replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_SECRET ?? "";

// Per-statement timeout for safety. Even read-only SELECTs can be expensive
// on a busy prod DB; cap at 15s so a runaway probe never lingers.
const STATEMENT_TIMEOUT = "15s";

const ROOT = process.cwd();

// ────────────────────────────────────────────────────────────────────────────
// SQL runner via `supabase db query --linked`.
//
// The CLI prints "Initialising login role..." to stderr on each call and the
// JSON payload + a "warning" string to stdout. We only care about stdout JSON.
// ────────────────────────────────────────────────────────────────────────────
function runSql(sql, label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  const sqlFile = path.join(tempDir, "q.sql");
  const wrapped = `set statement_timeout = '${STATEMENT_TIMEOUT}';\n${sql}\n`;
  fs.writeFileSync(sqlFile, wrapped, "utf8");

  const r = spawnSync(
    "supabase",
    ["db", "query", "--linked", "-o", "json", "--file", sqlFile],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );

  fs.rmSync(tempDir, { recursive: true, force: true });

  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim().slice(0, 800);
    return { ok: false, error: err, label };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    return { ok: true, rows: parsed.rows ?? [], label };
  } catch (e) {
    return {
      ok: false,
      error: `JSON parse failed: ${e.message}; raw stdout head: ${r.stdout.slice(0, 200)}`,
      label,
    };
  }
}

// EXPLAIN wrapper: prefixes the query with EXPLAIN, which validates schema
// references without executing the query body. Cheap and safe.
function rehearseSql(sql, label) {
  // Strip leading SELECT-like comments so EXPLAIN sits at the start.
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  // Multi-statement / DO blocks can't be EXPLAINed; skip them and report.
  if (/^(do|begin|create|insert|update|delete|alter|drop|truncate|with\s+recursive)\b/i.test(trimmed)) {
    return { ok: true, rows: [], label, note: "skipped (non-explainable)" };
  }
  return runSql(`explain ${trimmed}`, `${label} (EXPLAIN)`);
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP runner with timeout.
// ────────────────────────────────────────────────────────────────────────────
async function fetchJson(url, { headers = {}, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const latencyMs = Date.now() - start;
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
    return { ok: res.ok, status: res.status, latencyMs, body };
  } catch (e) {
    return { ok: false, status: 0, latencyMs: Date.now() - start, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Probe definitions.
//
// Each probe: { id, category, label, sql, grade(rows) -> {status, detail, value} }
// Status: "pass" | "warn" | "fail" | "skip" | "error"
// Critical probes are flagged in CRITICAL_IDS — a single CRITICAL fail flips
// the verdict to BROKEN.
// ────────────────────────────────────────────────────────────────────────────

const CRITICAL_IDS = new Set([
  "rails_today_exists",
  "rails_freshness",
  "snapshots_24h_flow",
  "fresh_24h_gate_margin",
  "http_homepage_renders",
  "http_top_mover_detail",
]);

const DB_PROBES = [
  {
    id: "rails_today_exists",
    category: "Rails",
    label: "Today's daily_top_movers row exists (cron-window aware)",
    sql: `
      select
        count(*) as today_rows,
        ((now() at time zone 'UTC')::time)::text as utc_time,
        case
          when (now() at time zone 'UTC')::time < '14:00:00' then 'before_first_cron'
          when (now() at time zone 'UTC')::time < '17:00:00' then 'after_1_of_3'
          when (now() at time zone 'UTC')::time < '21:00:00' then 'after_2_of_3'
          else 'after_all_3'
        end as cron_window
      from public.daily_top_movers
      where computed_at_date = (now() at time zone 'UTC')::date;
    `,
    grade(rows) {
      const r = rows[0] ?? {};
      const n = Number(r.today_rows ?? 0);
      const window = r.cron_window;
      const utc = r.utc_time;
      if (n >= 1) return { status: "pass", value: n, detail: `${n} rows for today (UTC=${utc}, ${window})` };
      // No row yet — grade by cron window.
      if (window === "before_first_cron") return {
        status: "pass",
        value: 0,
        detail: `no row yet but UTC=${utc} is before today's first cron at 14:00 UTC — homepage uses yesterday, by design`,
      };
      if (window === "after_1_of_3") return {
        status: "warn",
        value: 0,
        detail: `no row after first cron at 14:00 UTC (now ${utc}) — first attempt may have hit the gate; 17:00 UTC retry pending`,
        fix: "Watch /api/debug/pipeline-health; if fresh_24h still <18k, trigger /api/cron/run-scrydex-pipeline",
      };
      if (window === "after_2_of_3") return {
        status: "fail",
        value: 0,
        detail: `no row after 2 cron attempts (now ${utc}) — gate has tripped twice; only 21:00 UTC retry remaining`,
        fix: "Pipeline catalog freshness is stuck below 18k; investigate which sets are not being refreshed.",
      };
      return {
        status: "fail",
        value: 0,
        detail: `no row after all 3 daily cron attempts (now ${utc}) — rails stranded for today`,
        fix: "All three crons (14:00/17:00/21:00 UTC) missed the gate. This is the b3da2ed failure mode recurring.",
      };
    },
  },
  {
    id: "rails_freshness",
    category: "Rails",
    label: "Rails not stranded multi-day",
    sql: `
      select
        max(computed_at_date) as newest_date,
        ((now() at time zone 'UTC')::date - max(computed_at_date)) as days_stale,
        ((now() at time zone 'UTC')::time < '14:00:00') as before_today_first_cron
      from public.daily_top_movers;
    `,
    grade(rows) {
      const r = rows[0] ?? {};
      const days = Number(r.days_stale ?? 999);
      const newest = r.newest_date ?? "(none)";
      const beforeCron = r.before_today_first_cron === true || r.before_today_first_cron === "t";
      if (days <= 0) return { status: "pass", value: days, detail: `today's row present (newest=${newest})` };
      if (days === 1 && beforeCron) return {
        status: "pass", value: days,
        detail: `1 day behind (newest=${newest}) which is normal before today's first cron at 14:00 UTC`,
      };
      if (days === 1) return {
        status: "warn", value: days,
        detail: `1 day behind (newest=${newest}); after first cron of today, gate may have tripped once`,
      };
      return {
        status: "fail",
        value: days,
        detail: `${days} days stale (newest=${newest}) — CRITICAL per cron logging threshold`,
        fix: "Coverage gate stuck. Check /api/debug/pipeline-health and the compute_daily_top_movers cron logs.",
      };
    },
  },
  {
    id: "rails_rotation",
    category: "Rails",
    label: "Rail content rotates day-over-day",
    sql: `
      with recent_dates as (
        select distinct computed_at_date as day
        from public.daily_top_movers
        order by 1 desc
        limit 3
      ),
      day_pairs as (
        select d1.day as day_a, d2.day as day_b
        from recent_dates d1
        join recent_dates d2 on d1.day < d2.day
      ),
      pair_overlap as (
        select
          dp.day_a, dp.day_b,
          (select count(distinct canonical_slug) from public.daily_top_movers where computed_at_date = dp.day_a) as count_a,
          (select count(*) from (
             select canonical_slug from public.daily_top_movers where computed_at_date = dp.day_a
             intersect
             select canonical_slug from public.daily_top_movers where computed_at_date = dp.day_b
          ) shared) as shared
        from day_pairs dp
      )
      select
        (select count(*) from recent_dates) as distinct_dates,
        case when count(*) = 0 then null
          else round(avg(100.0 * shared::numeric / nullif(count_a, 0)), 1)
        end as avg_overlap_pct
      from pair_overlap;
    `,
    grade(rows) {
      const r = rows[0] ?? {};
      const dates = Number(r.distinct_dates ?? 0);
      const overlap = r.avg_overlap_pct === null || r.avg_overlap_pct === undefined
        ? null
        : Number(r.avg_overlap_pct);
      if (dates < 2) {
        return { status: "warn", value: dates, detail: `only ${dates} distinct day(s) in daily_top_movers — cannot measure rotation yet` };
      }
      if (overlap === null) return { status: "warn", value: null, detail: "overlap calc returned null" };
      if (overlap < 60) return { status: "pass", value: overlap, detail: `${overlap}% avg slug overlap across ${dates} recent days (lower is better — means rails turn over)` };
      if (overlap < 80) return { status: "warn", value: overlap, detail: `${overlap}% avg slug overlap across ${dates} days — rails turning over slowly` };
      return {
        status: "fail",
        value: overlap,
        detail: `${overlap}% avg slug overlap across ${dates} days — rails essentially frozen; suggests repeated fallback to a single computed day`,
        fix: "Coverage gate trips repeatedly OR data feeding compute_daily_top_movers isn't moving.",
      };
    },
  },
  {
    id: "fresh_24h_gate_margin",
    category: "Freshness",
    label: "Catalog freshness above the 18k coverage gate",
    sql: `
      select
        count(*) filter (where pcm.market_price_as_of > now() - interval '24 hours') as fresh_24h,
        count(*) filter (where pcm.market_price_as_of > now() - interval '72 hours') as fresh_72h,
        count(*) filter (where pcm.market_price_as_of > now() - interval '7 days')   as fresh_7d,
        count(*) filter (where pcm.market_price is null or pcm.market_price_as_of is null) as missing_price,
        count(*) as total_eligible
      from public.public_card_metrics pcm
      where pcm.grade = 'RAW' and pcm.printing_id is null;
    `,
    grade(rows) {
      const r = rows[0] ?? {};
      const fresh24 = Number(r.fresh_24h ?? 0);
      const fresh72 = Number(r.fresh_72h ?? 0);
      const total = Number(r.total_eligible ?? 0);
      const missing = Number(r.missing_price ?? 0);
      const gate = 18000;
      const pct72 = total > 0 ? Math.round((fresh72 / total) * 1000) / 10 : 0;
      const margin = fresh24 - gate;
      const detail = `fresh_24h=${fresh24} (gate=${gate}, margin=${margin > 0 ? "+" : ""}${margin}); fresh_72h=${fresh72} (${pct72}% of ${total}); missing_price=${missing}`;
      if (fresh24 < gate) return {
        status: "warn", value: fresh24, detail: `${detail} — UNDER gate; if not above ${gate} when next cron fires (14:00/17:00/21:00 UTC), that run will return without writing`,
        fix: "Watch the next cron tick. If gate stays under, trigger /api/cron/run-scrydex-pipeline to refresh more sets.",
      };
      if (fresh24 < gate * 1.15) return {
        status: "warn", value: fresh24, detail: `${detail} — within 15% of gate, a normal cadence dip could push under`,
      };
      return { status: "pass", value: fresh24, detail };
    },
  },
  {
    id: "snapshots_24h_flow",
    category: "Pipeline",
    label: "Scrydex price_snapshots flowing in last 24h",
    sql: `
      select
        provider,
        count(*) as snapshot_count,
        max(observed_at) as latest_observed,
        round(extract(epoch from (now() - max(observed_at))) / 60.0, 1) as latest_age_min
      from public.price_snapshots
      where observed_at >= now() - interval '24 hours'
      group by provider
      order by snapshot_count desc;
    `,
    grade(rows) {
      const scrydex = rows.find((r) => r.provider === "SCRYDEX");
      if (!scrydex) return {
        status: "fail",
        value: 0,
        detail: "ZERO SCRYDEX snapshots in last 24h — pipeline is dead",
        fix: "Trigger /api/cron/run-scrydex-pipeline; check /api/debug/pipeline-health for cooldowns.",
      };
      const n = Number(scrydex.snapshot_count ?? 0);
      const ageMin = Number(scrydex.latest_age_min ?? 0);
      const detail = `SCRYDEX: ${n} snapshots in 24h, latest ${ageMin}min ago` +
        (rows.length > 1 ? `; other providers: ${rows.filter(r => r.provider !== 'SCRYDEX').map(r => `${r.provider}=${r.snapshot_count}`).join(', ')}` : '');
      if (n < 1000) return { status: "fail", value: n, detail: `${detail} — far below expected volume` };
      if (ageMin > 360) return { status: "warn", value: n, detail: `${detail} — latest snapshot >6h old` };
      return { status: "pass", value: n, detail };
    },
  },
  {
    id: "provider_cooldowns",
    category: "Pipeline",
    label: "No active provider cooldowns",
    sql: `
      select provider, provider_set_id, last_status_code, consecutive_429,
        cooldown_until, last_attempt_at, last_success_at,
        round(extract(epoch from (cooldown_until - now())) / 60.0, 1) as remaining_min
      from public.provider_set_health
      where cooldown_until > now()
      order by cooldown_until desc;
    `,
    grade(rows) {
      if (rows.length === 0) return { status: "pass", value: 0, detail: "no active cooldowns" };
      const top = rows.slice(0, 3).map(r => `${r.provider}/${r.provider_set_id}=${r.remaining_min}min`).join(", ");
      return {
        status: "fail",
        value: rows.length,
        detail: `${rows.length} active cooldown(s): ${top}`,
        fix: "Investigate provider rate limits / credit cap; SCRYDEX __provider__ cooldown means full ingest halt.",
      };
    },
  },
  {
    id: "pipeline_queue_health",
    category: "Pipeline",
    // Real pipeline_jobs.status enum: QUEUED, RUNNING, RETRY, SUCCEEDED, FAILED.
    // Earlier lowercase filter (`'pending','running','queued'`) silently matched
    // nothing and reported "queue empty" while jobs were stuck — see audit
    // post-mortem 2026-05-04. Also: started_at age conflates "wedged" with
    // "cycling across attempts" — added heartbeat-age (locked_at) to
    // distinguish a genuinely-wedged worker (no heartbeat for >2min) from
    // a job that's just been claimed multiple times.
    label: "No stuck or excessively-queued pipeline_jobs",
    sql: `
      select
        status,
        count(*) as cnt,
        max(extract(epoch from (now() - coalesce(started_at, created_at))) / 60.0)::int as oldest_min,
        max(case when status = 'RUNNING' and locked_at is not null
              then extract(epoch from (now() - locked_at)) / 60.0
              else null end)::int as worst_heartbeat_age_min
      from public.pipeline_jobs
      where status in ('QUEUED','RUNNING','RETRY')
      group by status
      order by status;
    `,
    grade(rows) {
      const issues = [];
      let totalActive = 0;
      let worstHeartbeat = 0;
      for (const r of rows) {
        const cnt = Number(r.cnt);
        const ageMin = Number(r.oldest_min ?? 0);
        const hbMin = Number(r.worst_heartbeat_age_min ?? 0);
        totalActive += cnt;
        worstHeartbeat = Math.max(worstHeartbeat, hbMin);
        // Wedged = RUNNING with stale heartbeat. Cycling-across-attempts is OK
        // (jobs with max_attempts>1 may be claimed many times); only a dead
        // worker fails to update locked_at via touchPipelineJob (~30s cadence).
        if (r.status === "RUNNING" && hbMin > 2) issues.push(`RUNNING heartbeat stale=${hbMin}min (worker likely dead)`);
        if (r.status === "QUEUED" && cnt > 100) issues.push(`QUEUED=${cnt} (>100 backlog)`);
        if (r.status === "QUEUED" && ageMin > 180) issues.push(`QUEUED oldest=${ageMin}min (>3h waiting — worker not picking up)`);
        if (r.status === "RETRY" && cnt > 20) issues.push(`RETRY=${cnt} (>20 retrying — possible thrash)`);
      }
      const summary = rows.length === 0
        ? "queue empty"
        : rows.map(r => `${r.status}=${r.cnt}(oldest=${r.oldest_min}min)`).join(", ") + (worstHeartbeat ? `; worst RUNNING heartbeat=${worstHeartbeat}min` : "");
      if (issues.length > 0) return {
        status: "fail", value: totalActive,
        detail: `${summary}; issues: ${issues.join("; ")}`,
        fix: "Inspect pipeline_jobs for wedged rows; check process-provider-pipeline-jobs cron is firing every 3min.",
      };
      return { status: "pass", value: totalActive, detail: summary };
    },
  },
  {
    id: "pipeline_failure_rate",
    category: "Pipeline",
    // pipeline_jobs.status enum is uppercase. The earlier `'failed'` (lowercase)
    // matched zero rows and the audit reported 0% while real 7-day failure
    // rate was 22%.
    label: "Failed-job rate in last 24h is acceptable",
    sql: `
      select
        count(*) filter (where status = 'FAILED') as failed,
        count(*) as total
      from public.pipeline_jobs
      where created_at >= now() - interval '24 hours';
    `,
    grade(rows) {
      const r = rows[0] ?? {};
      const failed = Number(r.failed ?? 0);
      const total = Number(r.total ?? 0);
      if (total === 0) return { status: "warn", value: 0, detail: "no pipeline_jobs created in last 24h" };
      const pct = Math.round((failed / total) * 1000) / 10;
      const detail = `${failed}/${total} failed (${pct}%) in last 24h`;
      if (pct >= 20) return { status: "fail", value: pct, detail: `${detail} — high failure rate`, fix: "Inspect pipeline_jobs.last_error grouped by job_kind." };
      if (pct >= 5) return { status: "warn", value: pct, detail };
      return { status: "pass", value: pct, detail };
    },
  },
  {
    id: "pending_rollups_backlog",
    category: "Pipeline",
    // Raw count alone is noisy: the count spikes 2-4k during scheduled
    // Scrydex daily-batch runs, then drains within 1-2 cron cycles. What
    // actually indicates a broken drain is "rows older than the previous
    // drain tick". The drainer fires at :22/:52 — anything older than 30min
    // means a tick was missed.
    label: "pending_rollups draining within cron cadence",
    sql: `
      select
        count(*) as backlog,
        round(extract(epoch from (now() - min(queued_at))) / 60.0, 1) as oldest_age_min,
        round(extract(epoch from (now() - max(queued_at))) / 60.0, 1) as newest_age_min
      from public.pending_rollups;
    `,
    grade(rows) {
      const r = rows[0] ?? {};
      const n = Number(r.backlog ?? 0);
      const oldestMin = r.oldest_age_min === null ? 0 : Number(r.oldest_age_min);
      const newestMin = r.newest_age_min === null ? 0 : Number(r.newest_age_min);
      if (n === 0) return { status: "pass", value: n, detail: "queue empty" };
      const detail = `${n} pending; oldest=${oldestMin}min, newest=${newestMin}min`;
      // The drainer (batch-refresh-pipeline-rollups) runs at :22/:52, so any
      // entry older than 35min slipped a drain tick — actual broken-drainer
      // signal regardless of count.
      if (oldestMin > 60) return {
        status: "fail", value: oldestMin,
        detail: `${detail} — oldest entry >1h, drain has missed multiple cron ticks`,
        fix: "Check batch-refresh-pipeline-rollups cron logs; verify refresh RPCs aren't silently aborting (playbook line 381 diagnostic).",
      };
      if (oldestMin > 35) return {
        status: "warn", value: oldestMin,
        detail: `${detail} — oldest entry >35min, may have missed last :22/:52 tick`,
      };
      // Count-based warning only when age is fresh — useful as an upstream-load signal.
      if (n > 5000) return { status: "warn", value: n, detail: `${detail} — high count but draining; bursty intake` };
      return { status: "pass", value: n, detail };
    },
  },
  {
    id: "catalog_pricing_coverage",
    category: "Coverage",
    label: "% of canonical_cards with any non-null pricing",
    sql: `
      select
        count(*) as total_cards,
        count(*) filter (where pcm.market_price is not null) as priced,
        count(*) filter (where pcm.market_price is not null and pcm.market_price_as_of > now() - interval '7 days') as priced_recent
      from public.canonical_cards cc
      left join public.public_card_metrics pcm
        on pcm.canonical_slug = cc.slug and pcm.grade = 'RAW' and pcm.printing_id is null;
    `,
    grade(rows) {
      const r = rows[0] ?? {};
      const total = Number(r.total_cards ?? 0);
      const priced = Number(r.priced ?? 0);
      const recent = Number(r.priced_recent ?? 0);
      if (total === 0) return { status: "error", value: 0, detail: "canonical_cards is empty" };
      const pctAny = Math.round((priced / total) * 1000) / 10;
      const pctRecent = Math.round((recent / total) * 1000) / 10;
      const detail = `${priced}/${total} have pricing (${pctAny}%); ${recent} priced within 7d (${pctRecent}%)`;
      if (pctAny < 50) return { status: "fail", value: pctAny, detail: `${detail} — long-tail catalog has no pricing`, fix: "Backfill or expand provider coverage." };
      if (pctAny < 80) return { status: "warn", value: pctAny, detail };
      return { status: "pass", value: pctAny, detail };
    },
  },
  {
    id: "rail_snapshot_vs_current_price",
    category: "Consistency",
    label: "Rail-snapshot prices vs current prices (informational — homepage shows current via marketPulse)",
    sql: `
      with rail_day as (
        select max(computed_at_date) as day from public.daily_top_movers
      ),
      rails as (
        select dtm.canonical_slug, dtm.market_price as rail_price, dtm.computed_at_date
        from public.daily_top_movers dtm
        join rail_day rd on rd.day = dtm.computed_at_date
      )
      select
        (select day::text from rail_day) as rail_day,
        count(*) as rail_rows,
        count(*) filter (where pcm.market_price is null) as missing_now,
        count(*) filter (
          where pcm.market_price is not null
            and r.rail_price >= 20
            and abs(pcm.market_price - r.rail_price) / nullif(r.rail_price, 0) > 0.30
        ) as expensive_drifted_30pct,
        count(*) filter (
          where pcm.market_price is not null
            and r.rail_price >= 100
            and abs(pcm.market_price - r.rail_price) / nullif(r.rail_price, 0) > 0.50
        ) as premium_drifted_50pct
      from rails r
      left join public.public_card_metrics pcm
        on pcm.canonical_slug = r.canonical_slug
       and pcm.grade = 'RAW' and pcm.printing_id is null;
    `,
    grade(rows) {
      const r = rows[0] ?? {};
      const rail = Number(r.rail_rows ?? 0);
      const missing = Number(r.missing_now ?? 0);
      const exp30 = Number(r.expensive_drifted_30pct ?? 0);
      const prem50 = Number(r.premium_drifted_50pct ?? 0);
      const day = r.rail_day ?? "(none)";
      if (rail === 0) return { status: "skip", value: 0, detail: "no rail rows at all (covered by rails_today_exists)" };
      const detail = `rail_day=${day}; ${rail} rows; ${missing} now lack pricing; ${exp30} cards $20+ drifted >30%; ${prem50} cards $100+ drifted >50%`;
      // Important note: lib/data/homepage.ts uses marketPulse.marketPrice for display,
      // so users see current prices. This probe surfaces internal data lag, not display bugs.
      if (prem50 > 5) return { status: "warn", value: prem50, detail: `${detail} — internal rail data significantly stale; selection may have featured cards whose moves have already reversed`, fix: "Consider increasing compute_daily_top_movers cadence or using fresher input data." };
      if (exp30 > 20) return { status: "warn", value: exp30, detail };
      return { status: "pass", value: exp30, detail };
    },
  },
  {
    id: "high_confidence_freshness",
    category: "Freshness",
    label: "High-confidence cards (score≥80) not going stale (>72h)",
    sql: `
      select
        count(*) as stale_high_conf
      from public.public_card_metrics pcm
      where pcm.grade = 'RAW' and pcm.printing_id is null
        and pcm.market_confidence_score >= 80
        and (pcm.market_price_as_of is null or pcm.market_price_as_of < now() - interval '72 hours');
    `,
    grade(rows) {
      const n = Number(rows[0]?.stale_high_conf ?? 0);
      if (n < 500) return { status: "pass", value: n, detail: `${n} high-confidence cards stale >72h` };
      if (n < 2000) return { status: "warn", value: n, detail: `${n} high-confidence cards stale >72h — worst UX cohort decaying` };
      return { status: "fail", value: n, detail: `${n} high-confidence cards stale >72h — pipeline coverage skewed`, fix: "Check Scrydex set rotation; high-conf cards are the popular ones, must stay fresh." };
    },
  },
];

// ────────────────────────────────────────────────────────────────────────────
// HTTP probes (Layer 2 + Layer 3).
// ────────────────────────────────────────────────────────────────────────────
async function runHttpProbes(topMoverSlugs) {
  const results = [];

  // Homepage SSR — assert it responds 200 and has some HTML.
  {
    const url = `${APP_URL}/`;
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const text = await res.text();
      const looksLikeApp = text.includes("PopAlpha") || text.includes("popalpha") || text.length > 5000;
      results.push({
        id: "http_homepage_renders",
        category: "HTTP",
        label: "Homepage renders",
        status: res.ok && looksLikeApp ? "pass" : "fail",
        latencyMs: Date.now() - start,
        detail: `${res.status} ${res.ok ? "ok" : "BAD"}; html bytes=${text.length}; recognizable=${looksLikeApp}`,
      });
    } catch (e) {
      results.push({ id: "http_homepage_renders", category: "HTTP", label: "Homepage renders", status: "fail", latencyMs: Date.now() - start, detail: `error: ${e.message}` });
    }
  }

  // Top-mover detail probes — fetch detail for a sample of distinct cards.
  const detailResults = [];
  const distinctSlugs = [...new Set(topMoverSlugs)];
  const sample = distinctSlugs.slice(0, 5);
  const FRESH_72H_MS = 72 * 60 * 60 * 1000;
  for (const slug of sample) {
    const url = `${APP_URL}/api/cards/${encodeURIComponent(slug)}/detail`;
    const r = await fetchJson(url, { timeoutMs: 10_000 });
    const body = r.body ?? {};
    // Real shape: body.raw.variants[].pricing { marketPrice, scrydexPrice, asOf, providers[] }
    const variants = Array.isArray(body?.raw?.variants) ? body.raw.variants : [];
    let bestPrice = null;
    let bestAsOf = null;
    let bestProvider = null;
    for (const v of variants) {
      const p = v?.pricing;
      if (!p) continue;
      const market = p.marketPrice ?? p.scrydexPrice ?? null;
      if (market != null && (bestPrice == null || (typeof market === "number" && market > bestPrice))) {
        bestPrice = market;
        bestAsOf = p.asOf ?? null;
        bestProvider = (Array.isArray(p.providers) && p.providers[0]?.provider) || "(unknown)";
      }
    }
    const ageMs = bestAsOf ? Date.now() - new Date(bestAsOf).getTime() : null;
    const fresh = ageMs !== null && ageMs <= FRESH_72H_MS;
    detailResults.push({
      slug, status: r.status, latencyMs: r.latencyMs,
      hasPrice: bestPrice != null,
      bestPrice, bestProvider, bestAsOf, ageHours: ageMs !== null ? Math.round(ageMs / 3.6e6 * 10) / 10 : null,
      fresh,
      ok: r.ok && bestPrice != null && fresh,
    });
  }
  const passed = detailResults.filter(d => d.ok).length;
  const totalDetail = detailResults.length;
  const detailFails = detailResults.filter(d => !d.ok);
  const summarize = (d) => `${d.slug} status=${d.status} price=${d.bestPrice ?? 'null'} ageHours=${d.ageHours ?? 'null'}`;
  results.push({
    id: "http_top_mover_detail",
    category: "HTTP",
    label: "Top-mover card detail returns fresh pricing (≤72h)",
    status: totalDetail === 0 ? "skip" : (passed === totalDetail ? "pass" : (passed === 0 ? "fail" : "warn")),
    detail: totalDetail === 0
      ? "no slugs to probe (no rail rows at all)"
      : `${passed}/${totalDetail} returned fresh pricing; samples: ${detailResults.map(summarize).join(" | ")}` + (detailFails.length > 0 ? `; FAILED: ${detailFails.map(d => `${d.slug}(price=${d.bestPrice ?? 'null'},age=${d.ageHours ?? 'null'}h)`).join(', ')}` : ""),
    samples: detailResults,
  });

  // Search smoke — common Pokemon query. Real route is /api/search/cards.
  {
    const url = `${APP_URL}/api/search/cards?q=charizard&limit=5`;
    const r = await fetchJson(url, { timeoutMs: 10_000 });
    const items = r.body?.cards ?? r.body?.results ?? r.body?.items ?? r.body?.data ?? [];
    const n = Array.isArray(items) ? items.length : 0;
    results.push({
      id: "http_search",
      category: "HTTP",
      label: "Search returns results for 'charizard'",
      status: r.ok && n > 0 ? "pass" : (r.ok ? "warn" : "fail"),
      latencyMs: r.latencyMs,
      detail: `status=${r.status}; results=${n}`,
    });
  }

  // Layer 3: pipeline-health endpoint.
  if (CRON_SECRET) {
    const url = `${APP_URL}/api/debug/pipeline-health`;
    const r = await fetchJson(url, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      timeoutMs: 15_000,
    });
    const issues = Array.isArray(r.body?.issues) ? r.body.issues : [];
    const healthy = !!r.body?.healthy;
    const homepage = r.body?.homepage ?? {};
    results.push({
      id: "http_pipeline_health",
      category: "HTTP",
      label: "Internal /api/debug/pipeline-health endpoint",
      status: r.ok ? (healthy && issues.length === 0 ? "pass" : "warn") : "fail",
      latencyMs: r.latencyMs,
      detail: r.ok
        ? `healthy=${healthy}; issues=${issues.length}: ${issues.slice(0, 3).join(" | ") || "none"}; homepage.movers=${homepage?.movers ?? "?"}; freshness.metricsAgeHours=${r.body?.freshness?.metricsAgeHours ?? "?"}; cooldowns=${(r.body?.cooldowns ?? []).filter(c => c.active).length}`
        : `status=${r.status}`,
      raw: r.body,
    });
  } else {
    results.push({
      id: "http_pipeline_health",
      category: "HTTP",
      label: "Internal /api/debug/pipeline-health endpoint",
      status: "skip",
      detail: "CRON_SECRET not in env — set --env-file=.env.local",
    });
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Runner.
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const dbResults = [];

  for (const probe of DB_PROBES) {
    const res = REHEARSAL ? rehearseSql(probe.sql, probe.label) : runSql(probe.sql, probe.label);
    if (REHEARSAL) {
      if (res.ok) {
        dbResults.push({
          id: probe.id, category: probe.category, label: probe.label,
          status: "pass", detail: res.note ?? "EXPLAIN ok",
        });
      } else {
        dbResults.push({
          id: probe.id, category: probe.category, label: probe.label,
          status: "error", detail: `EXPLAIN failed: ${res.error.slice(0, 300)}`,
          sql: VERBOSE ? probe.sql : undefined,
        });
      }
      continue;
    }
    if (!res.ok) {
      dbResults.push({
        id: probe.id, category: probe.category, label: probe.label,
        status: "error", detail: res.error.slice(0, 400),
        sql: VERBOSE ? probe.sql : undefined,
      });
      continue;
    }
    let graded;
    try {
      graded = probe.grade(res.rows);
    } catch (e) {
      graded = { status: "error", detail: `grade() threw: ${e.message}` };
    }
    dbResults.push({ id: probe.id, category: probe.category, label: probe.label, ...graded, sql: VERBOSE ? probe.sql : undefined });
  }

  // Pull top-mover slugs for HTTP probes. Fall back to the newest available
  // day if today's row hasn't been computed yet (normal before 14:00 UTC).
  let topMoverSlugs = [];
  if (HTTP_MODE && !DB_ONLY && !REHEARSAL) {
    const r = runSql(
      `select canonical_slug
       from public.daily_top_movers
       where computed_at_date = (select max(computed_at_date) from public.daily_top_movers)
       order by rank asc
       limit 10;`,
      "fetch top movers for HTTP probe",
    );
    if (r.ok) topMoverSlugs = r.rows.map(x => x.canonical_slug).filter(Boolean);
  }

  const httpResults = (HTTP_MODE && !DB_ONLY && !REHEARSAL) ? await runHttpProbes(topMoverSlugs) : [];

  const allResults = [...dbResults, ...httpResults];

  // Verdict.
  const fails = allResults.filter(r => r.status === "fail");
  const warns = allResults.filter(r => r.status === "warn");
  const errors = allResults.filter(r => r.status === "error");
  const criticalFails = fails.filter(r => CRITICAL_IDS.has(r.id));

  let verdict;
  if (REHEARSAL) {
    verdict = errors.length === 0 ? "REHEARSAL PASSED" : "REHEARSAL FAILED";
  } else if (criticalFails.length > 0) {
    verdict = "BROKEN";
  } else if (fails.length > 0 || errors.length > 0) {
    verdict = "DEGRADED";
  } else if (warns.length > 0) {
    verdict = "DEGRADED (warnings only)";
  } else {
    verdict = "RELIABLE";
  }

  const summary = {
    verdict,
    rehearsal: REHEARSAL,
    duration_ms: Date.now() - t0,
    counts: {
      pass: allResults.filter(r => r.status === "pass").length,
      warn: warns.length,
      fail: fails.length,
      error: errors.length,
      skip: allResults.filter(r => r.status === "skip").length,
      total: allResults.length,
    },
    critical_fails: criticalFails.map(c => ({ id: c.id, detail: c.detail })),
    results: allResults,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printScorecard(summary);
  }

  // Exit non-zero on real failures (so CI/wrappers can detect).
  if (verdict === "BROKEN" || verdict === "REHEARSAL FAILED") process.exit(2);
  if (verdict.startsWith("DEGRADED")) process.exit(1);
  process.exit(0);
}

function printScorecard(s) {
  const ICON = { pass: "[PASS]", warn: "[WARN]", fail: "[FAIL]", error: "[ERR ]", skip: "[skip]" };
  const line = "─".repeat(72);
  console.log("");
  console.log(line);
  console.log(`PRICING RELIABILITY VERDICT: ${s.verdict}`);
  console.log(line);
  console.log(`Rehearsal: ${s.rehearsal} | Duration: ${s.duration_ms}ms | ${s.counts.pass}p / ${s.counts.warn}w / ${s.counts.fail}f / ${s.counts.error}e / ${s.counts.skip}s of ${s.counts.total}`);
  console.log("");

  const cats = ["Rails", "Freshness", "Pipeline", "Coverage", "Consistency", "HTTP"];
  for (const cat of cats) {
    const rows = s.results.filter(r => r.category === cat);
    if (rows.length === 0) continue;
    console.log(`── ${cat} ${"─".repeat(70 - cat.length - 4)}`);
    for (const r of rows) {
      console.log(`  ${ICON[r.status]} ${r.label}`);
      console.log(`         ${r.detail ?? ""}`);
      if (r.fix) console.log(`         FIX: ${r.fix}`);
    }
    console.log("");
  }

  if (s.critical_fails.length > 0) {
    console.log(line);
    console.log("CRITICAL FAILURES (these alone flip the verdict to BROKEN):");
    for (const c of s.critical_fails) console.log(`  - [${c.id}] ${c.detail}`);
    console.log(line);
  }
}

main().catch((e) => {
  console.error("audit crashed:", e);
  process.exit(3);
});
