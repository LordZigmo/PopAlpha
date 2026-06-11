-- Prune order: observations before payloads; index the ingest_id FK (2026-06-12).
--
-- supersedes: 20260611231500_prune_old_data_time_budgeted.sql
-- (body diffed against that definition: identical sections, identical
-- retention windows, loop structure, downsample headroom gate, and
-- budget_exhausted flag. Two deltas: the table ORDER changed, and the
-- provider_ingests filter column is fixed from created_at — which does
-- not exist; see section 9 — to ingested_at. Plus one new index outside
-- the function.)
--
-- Operating the 2026-06-11 drain surfaced a referential-action
-- amplification the table order steps straight into:
--
--   * provider_raw_payloads is referenced by provider_normalized_
--     observations via ON DELETE SET NULL, and the referencing column
--     is itself indexed — so none of the SET NULL updates are HOT.
--     Measured fan-out in prod: ~119 observation rows per payload row,
--     so one 10k-payload chunk fires ~1.19M row updates, each
--     maintaining all ~7 indexes on the 32 GB observations table. A
--     single chunk did not finish in 9 minutes. Payloads sat FIRST in
--     the table order, so every prune call burned its entire budget
--     there and the observations backlog (the actual volume driver)
--     was unreachable. This also retroactively explains the payload
--     backlog itself: the OLD function's 5k-payload chunk implied
--     ~600k amplified updates, which plausibly blew the nightly call's
--     statement_timeout and rolled back the whole prune for months.
--
--   * Once the observations backlog is drained, the SET NULL fan-out
--     from payload deletes drops to ~zero (fresh observations reference
--     fresh payloads), so ordering observations first eliminates the
--     amplification class rather than racing it.
--
--   * provider_ingests has the same shape via price_snapshots.ingest_id
--     (ON DELETE SET NULL) — but that column has NO index, so each
--     deleted ingest row seq-scans price_snapshots from the per-row RI
--     trigger. Ordering cannot fix this one (retained 45d snapshots
--     legitimately reference expired 30d ingests), so this migration
--     adds the missing FK-column index. price_snapshots is ~237k rows /
--     85 MB heap: the build is seconds inside the migration transaction.
--
-- New table order: the cascade-cheap tables first (observations'
-- ON DELETE CASCADE into provider_observation_matches is index-backed
-- and delete-only, i.e. no index maintenance), the two referential-
-- action-amplified tables (payloads, ingests) last.
--
-- Everything else — 10k chunks, per-table loop cap, ~95s clock budget
-- checked BEFORE each chunk, 20s downsample headroom gate,
-- budget_exhausted flag, grants — is unchanged from 20260611231500.

-- Missing FK-column index: price_snapshots.ingest_id references
-- provider_ingests(id) ON DELETE SET NULL; without this index every
-- ingest delete seq-scans price_snapshots via the per-row RI trigger.
create index if not exists price_snapshots_ingest_id_idx
  on public.price_snapshots (ingest_id);

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
  -- 1. provider_normalized_observations - 14-day retention (the 32 GB
  --    offender; pipeline-intermediate rows already consumed into
  --    price_snapshots / price_history_points). Runs FIRST: its drain
  --    is what collapses the payload SET NULL fan-out (section 8), and
  --    its ON DELETE CASCADE into provider_observation_matches is
  --    index-backed and delete-only, so chunks stay cheap.
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.provider_normalized_observations
    where  id in (
      select id from public.provider_normalized_observations
      where  observed_at < now() - interval '14 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('provider_normalized_observations', _table_total);

  -- 2. listing_observations - 14-day retention
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.listing_observations
    where  id in (
      select id from public.listing_observations
      where  observed_at < now() - interval '14 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('listing_observations', _table_total);

  -- 3. card_page_views - 90-day retention
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.card_page_views
    where  id in (
      select id from public.card_page_views
      where  viewed_at < now() - interval '90 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('card_page_views', _table_total);

  -- 4. price_snapshots - 45-day retention
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.price_snapshots
    where  id in (
      select id from public.price_snapshots
      where  observed_at < now() - interval '45 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('price_snapshots', _table_total);

  -- 5a. price_history_points - 90-day hard delete
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.price_history_points
    where  id in (
      select id from public.price_history_points
      where  ts < now() - interval '90 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('price_history_points', _table_total);

  -- 5b. price_history_points - downsample 30-31d window. The helper's
  --     LIMIT bounds its delete set, not its window scan over the slab,
  --     so one call can run for tens of seconds on a cold or bloated
  --     day — only start it with real headroom left. Catch-up passes
  --     that skip it are fine: steady-state nights keep up with the
  --     rolling one-day slab.
  if clock_timestamp() <= _deadline - interval '20 seconds' then
    _ds_deleted := coalesce(
      (public.downsample_price_history_points_batch(
        _chunk_limit,
        now() - interval '30 days',
        now() - interval '31 days'
      )->>'deleted')::int,
      0
    );
  else
    _ds_deleted := 0;
  end if;
  _result := _result || jsonb_build_object('price_history_points_downsampled', _ds_deleted);

  -- 6. provider_price_history - 180-day retention
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.provider_price_history
    where id in (
      select id from public.provider_price_history
      where recorded_at < now() - interval '180 days'
      limit _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('provider_price_history', _table_total);

  -- 7. ingest_runs - 30-day retention (SET NULL fan-out into
  --    tracked_refresh_diagnostics is index-backed and tiny)
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.ingest_runs
    where id in (
      select id from public.ingest_runs
      where started_at < now() - interval '30 days'
      limit _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('ingest_runs', _table_total);

  -- 8. provider_raw_payloads - 14-day retention. Runs AFTER the
  --    observations drain (section 1): each payload delete fires
  --    ON DELETE SET NULL into provider_normalized_observations, and
  --    the referencing column is indexed so the updates are never HOT —
  --    against a backlogged observations table one 10k chunk meant
  --    ~1.19M multi-index row updates. With observations drained the
  --    fan-out is ~zero.
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.provider_raw_payloads
    where  id in (
      select id from public.provider_raw_payloads
      where  fetched_at < now() - interval '14 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('provider_raw_payloads', _table_total);

  -- 9. provider_ingests - 30-day retention. Runs LAST: each delete
  --    fires SET NULL into price_snapshots; cheap now that
  --    price_snapshots_ingest_id_idx exists, but keep the amplified
  --    tables at the back as defense in depth.
  --
  --    Column fix (codex P1 on PR #223): every prior definition since
  --    20260413100000 filtered on provider_ingests.created_at, a column
  --    that DOES NOT EXIST (the table has ingested_at). plpgsql resolves
  --    columns at execution, so any call that reached this section threw
  --    42703 and rolled back the ENTIRE prune — the nightly job can
  --    never have completed past this point. This, compounded by the
  --    payload SET NULL amplification, is the real origin of the
  --    "retention silently lost for months" incident.
  _table_total := 0; _loops := 0;
  while clock_timestamp() <= _deadline and _loops < _max_loops_per_table loop
    delete from public.provider_ingests
    where  id in (
      select id from public.provider_ingests
      where  ingested_at < now() - interval '30 days'
      limit  _chunk_limit
    );
    get diagnostics _deleted = row_count;
    _table_total := _table_total + _deleted; _loops := _loops + 1;
    exit when _deleted < _chunk_limit;
  end loop;
  _result := _result || jsonb_build_object('provider_ingests', _table_total);

  -- A zero above can mean "table is clean" or "budget ran out before this
  -- table was reached" — this flag disambiguates for the cron log reader.
  _result := _result || jsonb_build_object(
    'budget_exhausted', clock_timestamp() > _deadline
  );

  return _result;
end;
$$;

revoke all on function public.prune_old_data(int) from public, anon, authenticated;
-- The cron route calls this through dbAdmin() (service_role). Default
-- ACLs already grant it EXECUTE today, but state that explicitly so the
-- nightly prune survives any future default-privilege hardening
-- (matches 20260522213801_harden_public_function_execute_contract).
grant execute on function public.prune_old_data(int) to service_role;
