-- =============================================================================
-- triage-pipeline-cpu-saturation.sql
--
-- Run these SELECTs in Supabase Studio SQL editor (read-only) to identify
-- the cause of CPU / Disk IO saturation on the pricing pipeline.
--
-- Usage: copy-paste each block one at a time, check the output against the
-- "look for" notes, and report back.
--
-- Incident context: docs/ingestion-pipeline-playbook.md incidents #6, #11, #13
-- Plan: /Users/popalpha/.claude/plans/delightful-swinging-music.md
-- =============================================================================

-- ── 1. Pipeline queue depth ──────────────────────────────────────────────────
-- Look for: RUNNING rows piling up, or FAILED / ZOMBIE counts > ~50.
select status, count(*) as rows
from pipeline_jobs
group by status
order by rows desc;

-- ── 2. Stuck / zombie pipeline jobs ──────────────────────────────────────────
-- Look for: any rows. Any job still RUNNING for >10 min is holding a row lock
-- and will block subsequent claim attempts. These need to be moved to FAILED.
select id,
       provider,
       status,
       started_at,
       now() - started_at as age,
       attempt_count,
       last_error
from pipeline_jobs
where status = 'RUNNING'
  and started_at < now() - interval '10 minutes'
order by started_at
limit 50;

-- ── 3. pending_rollups queue depth ───────────────────────────────────────────
-- Look for: count > 2000 indicates the rollup drain can't keep up.
-- Normal steady-state per playbook is <500.
select count(*) as pending_rollups from pending_rollups;

-- Oldest pending rollup (if > 1 hour, queue is backed up):
select min(enqueued_at) as oldest_pending, now() - min(enqueued_at) as age
from pending_rollups;

-- ── 4. Top-CPU queries (pg_stat_statements) ──────────────────────────────────
-- Look for: anything touching price_history_points, price_snapshots,
-- provider_normalized_observations, or pending_rollups at the top of the list.
-- If a single query is >20% of total_exec_time, that's the primary culprit.
select
  substring(query from 1 for 200)          as query_snippet,
  calls,
  round(mean_exec_time::numeric, 1)        as mean_ms,
  round(total_exec_time::numeric)          as total_ms,
  round(100.0 * total_exec_time
        / sum(total_exec_time) over ())    as pct_of_total
from pg_stat_statements
order by total_exec_time desc
limit 20;

-- ── 5. Table sizes ───────────────────────────────────────────────────────────
-- Look for: price_history_points still >5 GB (target is <1 GB after downsample),
-- or any provider_* observation table >2 GB (retention should cap these).
select
  relname,
  pg_size_pretty(pg_total_relation_size(oid)) as total_size,
  pg_size_pretty(pg_relation_size(oid))       as table_only,
  pg_size_pretty(pg_indexes_size(oid))        as indexes,
  (select reltuples::bigint
     from pg_class c2
     where c2.oid = c.oid)                    as est_row_count
from pg_class c
where relkind = 'r'
  and relnamespace = 'public'::regnamespace
order by pg_total_relation_size(oid) desc
limit 15;

-- ── 6. Index bloat on price_history_points ───────────────────────────────────
-- Look for: any unused indexes (idx_scan = 0) over 50 MB — candidates for drop.
select
  s.indexrelname             as index_name,
  pg_size_pretty(pg_relation_size(s.indexrelid)) as size,
  s.idx_scan                 as scans,
  s.idx_tup_read             as tup_reads
from pg_stat_user_indexes s
where s.schemaname = 'public'
  and s.relname in ('price_history_points', 'price_snapshots',
                    'provider_normalized_observations', 'listing_observations',
                    'pipeline_jobs', 'pending_rollups')
order by pg_relation_size(s.indexrelid) desc;

-- ── 7. Freshness — actual vs addressable ────────────────────────────────────
-- Look for: fresh_24h << addressable. SLO is fresh_24h / addressable >= 0.90.
-- User reports ~7k priced; addressable is ~18k.
select
  count(*) filter (where market_price is not null) as priced,
  count(*) filter (where market_price is not null
                   and market_price_as_of > now() - interval '24 hours') as fresh_24h,
  count(*) filter (where market_price is not null
                   and market_price_as_of > now() - interval '7 days')   as fresh_7d,
  count(*) as addressable
from public_card_metrics
where grade = 'RAW' and printing_id is null;

-- ── 8. Price-history volume by age ───────────────────────────────────────────
-- Look for: anything older than 30 days that isn't down-sampled
-- (many rows/day after the 30d cutoff = downsample backlog).
select
  date_trunc('day', ts) as day,
  count(*)              as rows_per_day
from price_history_points
where ts < now() - interval '30 days'
group by 1
order by 1
limit 60;

-- ── 9. Currently-running activity (live snapshot) ───────────────────────────
-- Look for: long-running queries (>60s), queries waiting on locks (wait_event),
-- or many concurrent identical queries (indicates serialization on a lock).
select
  pid,
  usename,
  state,
  wait_event_type,
  wait_event,
  now() - query_start as running_for,
  substring(query from 1 for 200) as query
from pg_stat_activity
where state <> 'idle'
  and pid <> pg_backend_pid()
order by query_start nulls last
limit 30;

-- ── 10. Recent pipeline job durations ───────────────────────────────────────
-- Look for: median duration trending up over last 24h, or success_rate < 90%.
-- (Replace column names if schema differs.)
select
  date_trunc('hour', started_at) as hour,
  count(*)                        as jobs,
  count(*) filter (where status = 'SUCCESS') as ok,
  count(*) filter (where status = 'FAILED')  as failed,
  round(avg(extract(epoch from (finished_at - started_at)))::numeric, 1) as avg_sec
from pipeline_jobs
where started_at > now() - interval '24 hours'
  and finished_at is not null
group by 1
order by 1 desc
limit 24;
