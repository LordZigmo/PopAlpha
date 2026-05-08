-- 20260509150000_sets_refresh_and_sync_trigger.sql
--
-- PR 2 of the sets-table promotion (PR 1 = #34, sets catalog seed). This PR
-- keeps `public.sets` in sync with `public.card_printings` going forward —
-- without it, the sets table is a one-time snapshot from PR 1 and goes
-- stale as new printings/sets land via Scrydex / dashboard / scraper imports.
--
-- Two halves:
--
--   1. RPCs:
--        public.refresh_sets_for_set_ids(text[])  — incremental: re-derive
--                                                   the given set_ids only.
--        public.refresh_sets_from_printings()     — full: re-derive every
--                                                   set_id present in either
--                                                   card_printings or sets,
--                                                   deletes orphans whose
--                                                   printings vanished.
--
--   2. AFTER STATEMENT triggers on card_printings (INSERT / UPDATE OF set_name
--      / DELETE) using transition tables to pass the affected set_names to
--      refresh_sets_for_set_ids in one batch. Statement-level (not row-level)
--      so a 10k-row Scrydex import fires the trigger ONCE with all 10k rows
--      visible, not 10k times.
--
-- Refresh semantics:
--
--   * derived_card_count   — always recomputed from card_printings.
--   * language             — recomputed (most-common per set), but never
--                             overwrites a non-null existing value with NULL.
--   * year                 — always recomputed (min(year)).
--   * set_name             — refreshed (min(set_name) per set_id).
--   * release_date, era,
--     parent_set_id,
--     official_card_count  — never touched. These are PR 4's curated columns.
--
-- Behavior on row-by-row INSERTs:
--
--   The trigger is statement-level so a single bulk INSERT fires it once.
--   But a script doing INSERT-per-row in a loop fires it N times — each call
--   to refresh_sets_for_set_ids runs aggregate queries across card_printings
--   for the affected sets. Acceptable for the Scrydex import path which uses
--   chunked bulk INSERTs (lib/admin/scrydex-canonical-import.ts:454) but
--   would be expensive if a future writer ever inserts row-at-a-time.

-- ── Expression index on card_printings(normalize_set_id(set_name)) ──────────
-- The refresh function filters card_printings by `normalize_set_id(set_name) =
-- any(p_set_ids)`. Without this index, Postgres has to evaluate the function
-- for every row in card_printings (~700k) to plan the predicate — a seq scan
-- per trigger fire. With the expression index, the equality lookup is
-- O(log n).
--
-- Will be made redundant by PR 3 when card_printings.set_id becomes a
-- regular column with a normal btree index. Drop this index in that PR.

create index if not exists card_printings_normalize_set_id_idx
  on public.card_printings (public.normalize_set_id(set_name))
  where set_name is not null;

-- ── refresh_sets_for_set_ids ────────────────────────────────────────────────
-- The workhorse. Given a list of set_ids, re-derive their sets rows from
-- current card_printings state. Sets with zero printings get deleted.

create or replace function public.refresh_sets_for_set_ids(p_set_ids text[])
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_affected int := 0;
  v_deleted  int := 0;
  v_upserted int := 0;
begin
  if p_set_ids is null or array_length(p_set_ids, 1) is null then
    return 0;
  end if;

  -- Delete any sets row whose set_id is in the input list and no longer
  -- has any backing card_printings rows. Triggered by DELETE/UPDATE that
  -- removed the last printing for a set.
  delete from public.sets s
  where s.set_id = any(p_set_ids)
    and not exists (
      select 1 from public.card_printings cp
      where public.normalize_set_id(cp.set_name) = s.set_id
    );
  get diagnostics v_deleted = row_count;

  -- Re-derive each remaining set_id in the input list. Same aggregation
  -- shape as PR 1's seed: most-common language wins, min(year), count(*).
  with by_set_lang as (
    select
      public.normalize_set_id(cp.set_name) as set_id,
      cp.language,
      count(*) as n
    from public.card_printings cp
    where cp.set_name is not null
      and cp.language is not null
      and public.normalize_set_id(cp.set_name) = any(p_set_ids)
    group by public.normalize_set_id(cp.set_name), cp.language
  ),
  top_lang as (
    select distinct on (set_id) set_id, language
    from by_set_lang
    order by set_id, n desc, language
  ),
  by_set as (
    select
      public.normalize_set_id(cp.set_name) as set_id,
      min(cp.set_name) as set_name,
      min(cp.year) as year,
      count(*) as derived_card_count
    from public.card_printings cp
    where cp.set_name is not null
      and public.normalize_set_id(cp.set_name) = any(p_set_ids)
    group by public.normalize_set_id(cp.set_name)
  )
  insert into public.sets (
    set_id, set_name, language, year, derived_card_count, source, updated_at
  )
  select
    bs.set_id,
    bs.set_name,
    tl.language,
    bs.year,
    bs.derived_card_count,
    'refresh_rpc',
    now()
  from by_set bs
  left join top_lang tl on tl.set_id = bs.set_id
  on conflict (set_id) do update set
    set_name           = excluded.set_name,
    -- Prefer freshly-derived language; fall back to existing if fresh is NULL.
    -- Never overwrite a curated language (PR 4 sources) with NULL.
    language           = coalesce(excluded.language, public.sets.language),
    year               = excluded.year,
    derived_card_count = excluded.derived_card_count,
    -- Preserve any source that's NOT one of the refresh-machine markers.
    -- Denylist (vs allowlist) is robust to PR 4 picking a curated source
    -- name we don't anticipate here — if it's not a known-machine source,
    -- it's curated and stays.
    source             = case
                            when public.sets.source in ('card_printings_seed','refresh_rpc')
                              then excluded.source
                            else public.sets.source
                          end,
    updated_at         = now();
  get diagnostics v_upserted = row_count;

  v_affected := v_deleted + v_upserted;
  return v_affected;
end;
$$;

comment on function public.refresh_sets_for_set_ids(text[]) is
  'Incremental re-derive of public.sets rows for the given set_ids from current card_printings state. Deletes sets whose set_id no longer has any card_printings rows. Preserves curated columns (release_date, era, parent_set_id, official_card_count) — only refreshes derived_card_count, year, set_name, and language. Called by card_printings AFTER triggers and by refresh_sets_from_printings().';

-- ── refresh_sets_from_printings ─────────────────────────────────────────────
-- Full sync: re-derive every set_id present in either card_printings or sets.
-- The union catches orphans (sets rows whose printings have been deleted) so
-- they get cleaned up too.

create or replace function public.refresh_sets_from_printings()
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_set_ids text[];
begin
  select array_agg(distinct sid)
  into v_set_ids
  from (
    select public.normalize_set_id(set_name) as sid
    from public.card_printings
    where set_name is not null
    union
    select set_id
    from public.sets
  ) s
  where sid is not null;

  if v_set_ids is null then
    return 0;
  end if;
  return public.refresh_sets_for_set_ids(v_set_ids);
end;
$$;

comment on function public.refresh_sets_from_printings() is
  'Full re-derive of public.sets from card_printings. Catches orphans (sets rows with no backing printings) and deletes them. Idempotent. Operator-callable for periodic sync; ordinarily the AFTER triggers on card_printings keep sets fresh automatically.';

-- Restrict refresh RPCs to service role.
revoke all on function public.refresh_sets_for_set_ids(text[]) from public, anon, authenticated;
revoke all on function public.refresh_sets_from_printings() from public, anon, authenticated;

-- ── AFTER triggers on card_printings ────────────────────────────────────────
-- Three separate trigger functions because PostgreSQL's REFERENCING clause
-- restrictions: AFTER INSERT can only see NEW table, AFTER DELETE can only
-- see OLD table, AFTER UPDATE sees both. A single function can't safely
-- access whichever transition table exists at runtime.

create or replace function public.card_printings_after_insert_sync_sets()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_set_ids text[];
begin
  select array_agg(distinct public.normalize_set_id(set_name))
  into v_set_ids
  from new_rows
  where set_name is not null;
  if v_set_ids is not null then
    perform public.refresh_sets_for_set_ids(v_set_ids);
  end if;
  return null;
end;
$$;

create or replace function public.card_printings_after_update_sync_sets()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_set_ids text[];
begin
  -- UPDATE can change set_name → affects BOTH the old set_id and the new one
  -- (e.g. a printing reclassified from "Base Set" to "Base Set Shadowless"
  -- changes the count on both sides).
  --
  -- BUT: AFTER UPDATE OF set_name fires whenever set_name appears in the SET
  -- clause, even if the value didn't change. Scrydex bulk upsert at
  -- lib/admin/scrydex-canonical-import.ts writes set_name on every conflict
  -- row, and import-pokemon-tcg-data-local.mjs does row-by-row updates that
  -- include set_name. Without the IS DISTINCT FROM gate below, every Scrydex
  -- re-import would fire refresh_sets_for_set_ids per chunk for no reason.
  --
  -- Join transition tables on id, only consider rows where set_name actually
  -- changed. Result: the trigger body is a no-op when set_name updates are
  -- value-stable, regardless of how many rows the statement touched.
  select array_agg(distinct sid)
  into v_set_ids
  from (
    select public.normalize_set_id(n.set_name) as sid
    from new_rows n
    join old_rows o on o.id = n.id
    where n.set_name is distinct from o.set_name
      and n.set_name is not null
    union
    select public.normalize_set_id(o.set_name) as sid
    from new_rows n
    join old_rows o on o.id = n.id
    where n.set_name is distinct from o.set_name
      and o.set_name is not null
  ) s
  where sid is not null;
  if v_set_ids is not null then
    perform public.refresh_sets_for_set_ids(v_set_ids);
  end if;
  return null;
end;
$$;

create or replace function public.card_printings_after_delete_sync_sets()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_set_ids text[];
begin
  select array_agg(distinct public.normalize_set_id(set_name))
  into v_set_ids
  from old_rows
  where set_name is not null;
  if v_set_ids is not null then
    perform public.refresh_sets_for_set_ids(v_set_ids);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_card_printings_after_insert_sync_sets on public.card_printings;
create trigger trg_card_printings_after_insert_sync_sets
  after insert on public.card_printings
  referencing new table as new_rows
  for each statement
  execute function public.card_printings_after_insert_sync_sets();

-- AFTER UPDATE OF set_name only — UPDATEs that don't touch set_name (price
-- refreshes, image embedding metadata, etc.) shouldn't fire the sync.
drop trigger if exists trg_card_printings_after_update_sync_sets on public.card_printings;
create trigger trg_card_printings_after_update_sync_sets
  after update of set_name on public.card_printings
  referencing new table as new_rows old table as old_rows
  for each statement
  execute function public.card_printings_after_update_sync_sets();

drop trigger if exists trg_card_printings_after_delete_sync_sets on public.card_printings;
create trigger trg_card_printings_after_delete_sync_sets
  after delete on public.card_printings
  referencing old table as old_rows
  for each statement
  execute function public.card_printings_after_delete_sync_sets();

-- ── One-time sync at apply time ─────────────────────────────────────────────
-- card_printings may have been mutated since PR 1's seed ran (PR 1 applied
-- 2026-05-08 19:15 UTC; PR 2 applies same day). Bring sets fully in sync now
-- so the post-migration state matches what the triggers would have produced
-- if they'd been in place all along. Refresh touches all 401 sets rows
-- (UPDATEs the cache fields + bumps updated_at) but doesn't change row count
-- materially. ANALYZE refreshes planner stats since we've UPDATEd every row.
select public.refresh_sets_from_printings();
analyze public.sets;

-- ── Rollback (manual, NOT auto-applied) ─────────────────────────────────────
-- If this migration needs to be reverted, run as a NEW migration:
--
--   drop trigger if exists trg_card_printings_after_delete_sync_sets on public.card_printings;
--   drop trigger if exists trg_card_printings_after_update_sync_sets on public.card_printings;
--   drop trigger if exists trg_card_printings_after_insert_sync_sets on public.card_printings;
--   drop function if exists public.card_printings_after_delete_sync_sets();
--   drop function if exists public.card_printings_after_update_sync_sets();
--   drop function if exists public.card_printings_after_insert_sync_sets();
--   drop function if exists public.refresh_sets_from_printings();
--   drop function if exists public.refresh_sets_for_set_ids(text[]);
--   drop index if exists public.card_printings_normalize_set_id_idx;
--
-- public.sets data survives unchanged. PR 1's catalog table is independent
-- of this PR's machinery.
