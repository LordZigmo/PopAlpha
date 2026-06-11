-- Time-budgeted prune_old_data (2026-06-11).
--
-- supersedes: 20260524230328_provider_price_history_foundation.sql
-- (body diffed against that definition: all eight prune sections kept
-- identical retention windows and key columns; downsample call kept the
-- same args; ingest_runs is the only new section.)
--
-- The previous definition deleted at most ONE 5,000-row chunk per table
-- per nightly run — sized long before the Scrydex volume-budget work
-- (2026-06-10) scaled pipeline throughput. Daily inflow into
-- provider_normalized_observations alone exceeds the nightly prune by
-- orders of magnitude, so the 14-day retention became aspirational:
-- the table reached 32 GB (≈half the database) with the backlog
-- compounding nightly. Same failure class as the timeseries starvation
-- incident: a flat cap that volume silently outgrew.
--
-- This version loops per table — chunked deletes until the table is
-- caught up, a per-table loop cap is hit, or the global clock budget is
-- exhausted — so steady-state nights cost what they always did, while
-- backlogged tables actually drain. The function takes an optional
-- per-table chunk-loop cap so an operator can run aggressive catch-up
-- passes (`select prune_old_data(50);` repeatedly) without redefining
-- anything; the cron's bare rpc() call keeps the conservative default.
--
-- Also adds ingest_runs (30d) — 4.4 GB of run logs had no retention at
-- all — and ships a one-time ANALYZE so the planner sees the new
-- reality after big drains.
--
-- NOTE ON DISK RECLAIM: deletes mark space reusable but do not shrink
-- files. After the backlog drains, run off-peak:
--   vacuum (full, verbose, analyze) public.provider_normalized_observations;
-- (takes an exclusive lock for the duration; pipeline jobs retry) and
-- consider REINDEX CONCURRENTLY on price_history_points' indexes
-- (8 GB of indexes over a 2 GB table after the March shrink).

create or replace function public.prune_old_data(_max_loops_per_table int default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '110s'
as $$
declare
  _chunk_limit  int := 10000;
  -- Leave headroom under statement_timeout so we return a result instead
  -- of being killed mid-loop.
  _deadline     timestamptz := clock_timestamp() + interval '95 seconds';
  _deleted      int;
  _table_total  int;
  _loops        int;
  _ds_deleted   int;
  _result       jsonb := '{}'::jsonb;
begin
  -- 1. provider_raw_payloads - 14-day retention
  _table_total := 0; _loops := 0;
  loop
    delete from public.provider_raw_payloads
    where  id in (
      select id from public.provider_raw_payloads
      where  fetched_at < now() - interval '14 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('provider_raw_payloads', _table_total);

  -- 2. provider_ingests - 30-day retention
  _table_total := 0; _loops := 0;
  loop
    delete from public.provider_ingests
    where  id in (
      select id from public.provider_ingests
      where  created_at < now() - interval '30 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('provider_ingests', _table_total);

  -- 3. provider_normalized_observations - 14-day retention (the 32 GB
  --    offender; pipeline-intermediate rows already consumed into
  --    price_snapshots / price_history_points)
  _table_total := 0; _loops := 0;
  loop
    delete from public.provider_normalized_observations
    where  id in (
      select id from public.provider_normalized_observations
      where  observed_at < now() - interval '14 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('provider_normalized_observations', _table_total);

  -- 4. listing_observations - 14-day retention
  _table_total := 0; _loops := 0;
  loop
    delete from public.listing_observations
    where  id in (
      select id from public.listing_observations
      where  observed_at < now() - interval '14 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('listing_observations', _table_total);

  -- 5. card_page_views - 90-day retention
  _table_total := 0; _loops := 0;
  loop
    delete from public.card_page_views
    where  id in (
      select id from public.card_page_views
      where  viewed_at < now() - interval '90 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('card_page_views', _table_total);

  -- 6. price_snapshots - 45-day retention
  _table_total := 0; _loops := 0;
  loop
    delete from public.price_snapshots
    where  id in (
      select id from public.price_snapshots
      where  observed_at < now() - interval '45 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('price_snapshots', _table_total);

  -- 7a. price_history_points - 90-day hard delete
  _table_total := 0; _loops := 0;
  loop
    delete from public.price_history_points
    where  id in (
      select id from public.price_history_points
      where  ts < now() - interval '90 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('price_history_points', _table_total);

  -- 7b. price_history_points - downsample 30-31d window (unchanged: the
  --     batch helper bounds its own work)
  _ds_deleted := coalesce(
    (public.downsample_price_history_points_batch(
      _chunk_limit,
      now() - interval '30 days',
      now() - interval '31 days'
    )->>'deleted')::int,
    0
  );
  _result := _result || jsonb_build_object('price_history_points_downsampled', _ds_deleted);

  -- 8. provider_price_history - 180-day retention
  _table_total := 0; _loops := 0;
  loop
    delete from public.provider_price_history
    where id in (
      select id from public.provider_price_history
      where recorded_at < now() - interval '180 days'
      limit _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('provider_price_history', _table_total);

  -- 9. ingest_runs - 30-day retention (NEW: 4.4 GB of run logs had no
  --    retention at all)
  _table_total := 0; _loops := 0;
  loop
    delete from public.ingest_runs
    where id in (
      select id from public.ingest_runs
      where started_at < now() - interval '30 days'
      limit _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit
           or _loops >= _max_loops_per_table
           or clock_timestamp() > _deadline;
  end loop;
  _result := _result || jsonb_build_object('ingest_runs', _table_total);

  return _result;
end;
$$;

revoke all on function public.prune_old_data(int) from public, anon, authenticated;

-- The zero-arg signature was replaced by the defaulted-arg one above;
-- drop the old function if it still exists under its original signature
-- so there's exactly one definition. (create or replace with a new
-- default arg creates a NEW overload rather than replacing.)
drop function if exists public.prune_old_data();
