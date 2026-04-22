-- =============================================================================
-- unblock-pipeline-queue-20260416.sql
--
-- One-shot queue unblock after deploying commit e415db8
-- (PROVIDER_OBSERVATION_CLEANUP_LIKE_FALLBACK_ENABLED default=off).
--
-- Preconditions:
--   1. Commit e415db8 is LIVE on Vercel (check deployments dashboard).
--   2. Supabase CPU has dropped below ~70% (confirms fix is effective).
--
-- If those aren't true yet, wait — requeueing jobs while the LIKE-OR path
-- is still executing would just pile the backlog on top of a saturated DB.
--
-- Run each block in order. Check row counts against expectations.
-- =============================================================================

-- ── 0. Sanity check (read-only) — confirm state before writing ──────────────
-- Expected: ~10 RUNNING zombies, ~1932 FAILED, ~149 QUEUED.
-- If numbers have shifted dramatically, re-assess before proceeding.
select status, count(*) as rows
from pipeline_jobs
group by status
order by rows desc;

-- Also confirm CPU is back. Top query should no longer be a LIKE-OR scan:
select
  substring(query from 1 for 120) as query_snippet,
  calls,
  round(mean_exec_time::numeric, 1) as mean_ms,
  round(total_exec_time::numeric)   as total_ms
from pg_stat_statements
order by total_exec_time desc
limit 5;
-- If you still see "variant_ref like ... OR variant_ref like" in the top 3,
-- STOP. The fix isn't live yet. Go check Vercel deployment status.


-- ── 1. Move zombie RUNNING jobs to FAILED ──────────────────────────────────
-- These are jobs whose claimant either crashed or hit the 480s orchestrator
-- timeout without cleanly updating status. They hold row locks and block
-- claim attempts on their provider partition. Moving to FAILED lets the
-- queue flow again; step 2 will requeue them.
--
-- Expected: ~10 rows updated.
update pipeline_jobs
set status     = 'FAILED',
    finished_at = coalesce(finished_at, now()),
    last_error = coalesce(last_error, '') || ' [ops 2026-04-16: zombie after LIKE-OR fix]'
where status = 'RUNNING'
  and started_at < now() - interval '10 minutes'
returning id, provider, started_at;


-- ── 2. Requeue recent FAILED so the pipeline retries with the new fix ──────
-- These failed primarily because of the LIKE-OR timeout. With the fix live,
-- they should now complete quickly.
--
-- Expected: ~1900 rows updated (7-day window). If you see a much higher
-- number (>5000), narrow the window before running.
update pipeline_jobs
set status      = 'QUEUED',
    started_at  = null,
    finished_at = null,
    last_error  = coalesce(last_error, '') || ' [ops 2026-04-16: requeued after LIKE-OR fix]'
where status = 'FAILED'
  and finished_at > now() - interval '7 days';
-- Returns "UPDATE <count>" in Supabase studio — expected ~1900.


-- ── 3. Post-check (read-only) — confirm queue is flowing ───────────────────
-- Run this 5 minutes after step 2. Should show RUNNING count > 0 and
-- SUCCEEDED count climbing.
select status, count(*) as rows
from pipeline_jobs
group by status
order by rows desc;

-- And confirm freshness is recovering (run this every ~15 min):
select
  count(*) filter (where market_price is not null
                   and market_price_as_of > now() - interval '24 hours') as fresh_24h,
  count(*) as addressable,
  round(100.0 * count(*) filter (where market_price is not null
                                 and market_price_as_of > now() - interval '24 hours')
        / nullif(count(*), 0), 1) as pct_fresh
from public_card_metrics
where grade = 'RAW' and printing_id is null;
-- Target: pct_fresh climbs from ~39 toward 90+ over 2-3 pipeline cycles.


-- ── ROLLBACK (only if jobs are re-failing in a way that's hurting the DB) ──
-- If the requeue creates a thundering herd that crashes things again, you
-- can mark them FAILED again:
--
-- update pipeline_jobs
-- set status = 'FAILED',
--     last_error = coalesce(last_error, '') || ' [ops 2026-04-16: re-failed after thundering herd]'
-- where status = 'QUEUED'
--   and started_at is null
--   and last_error like '%[ops 2026-04-16: requeued%';
