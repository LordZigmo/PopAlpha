-- 20260509170000_card_printings_set_id_fk.sql
--
-- supersedes: 20260509150000_sets_refresh_and_sync_trigger.sql
--   Function bodies updated by this migration:
--     public.refresh_sets_for_set_ids(text[])
--     public.card_printings_after_insert_sync_sets()
--     public.card_printings_after_update_sync_sets()
--     public.card_printings_after_delete_sync_sets()
--   Diff vs prior bodies: filter changes from
--     `where normalize_set_id(cp.set_name) = any(p_set_ids)` (PR 2)
--   to
--     `where cp.set_id = any(p_set_ids)` (this PR)
--   And the AFTER UPDATE function gates on
--     `n.set_id IS DISTINCT FROM o.set_id` instead of
--     `n.set_name IS DISTINCT FROM o.set_name`. Both gates are
--   semantically equivalent because card_printings_set_id_matches_set_name_chk
--   (added below) enforces set_id = normalize_set_id(set_name) row-by-row.
--
-- PR 3 of the sets-table promotion. PR 1 (#34) shipped the catalog,
-- PR 2 (#35 + #36) shipped the refresh RPCs and AFTER triggers on
-- card_printings. This PR adds a real `set_id text` FK column on
-- card_printings, backfills existing rows, and installs BEFORE INSERT
-- / UPDATE OF set_name triggers so the column is auto-populated for
-- all future writes.
--
-- After this PR, the existing call sites that compute set_id at read
-- time (`normalize_set_id(set_name)` in 6 places in the
-- 20260302110000_set_summary_pipeline.sql refresh functions, the
-- canonical_set_catalog view, etc.) can be migrated to use the
-- column directly. Those reader migrations are out of scope here —
-- this PR only adds the column + keeps it correct.
--
-- The expression index added by PR 2
-- (`card_printings_normalize_set_id_idx`) becomes redundant once the
-- column exists with a regular btree index. Dropped at the end of
-- this migration.
--
-- The PR 2 trigger functions (`card_printings_after_*_sync_sets`)
-- and `refresh_sets_for_set_ids` are also updated to read the new
-- `set_id` column directly instead of recomputing
-- `normalize_set_id(set_name)`. Faster (btree vs expression) and
-- one consistent code path.
--
-- Sequencing constraint: the order inside this migration matters.
--   1. Pre-flight check — every set_id derivable from card_printings
--      exists in sets. Fails the migration before any column-add if
--      drift snuck in.
--   2. ALTER TABLE ADD COLUMN — instant for nullable, no default.
--   3. BEFORE triggers — installed BEFORE backfill so any concurrent
--      INSERT during backfill gets set_id auto-populated.
--   4. Backfill — inline UPDATE of all 700k rows. Tractable inside the
--      migration tx (single statement, ~30s based on size).
--   5. Update PR 2 functions to use the new column.
--   6. Drop the now-redundant PR 2 expression index.

-- ── Pre-flight check ────────────────────────────────────────────────────────
-- Every distinct normalize_set_id(set_name) in card_printings must
-- already exist in public.sets, else the FK creation + backfill
-- would fail mid-migration. PR 2's inline refresh + AFTER triggers
-- have been keeping sets in sync, so this should pass; verify.

do $$
declare
  bad_set_id text;
begin
  for bad_set_id in
    select distinct public.normalize_set_id(set_name)
    from public.card_printings
    where set_name is not null
      and public.normalize_set_id(set_name) not in (select set_id from public.sets)
  loop
    raise exception 'card_printings has set_name normalizing to set_id ''%'' that does not exist in public.sets. Add to catalog before this migration runs (e.g. via select public.refresh_sets_from_printings()).', bad_set_id
      using errcode = 'foreign_key_violation';
  end loop;
end$$;

-- ── ALTER TABLE: add set_id ─────────────────────────────────────────────────

alter table public.card_printings
  add column if not exists set_id text null
    references public.sets(set_id) on delete restrict;

create index if not exists card_printings_set_id_idx
  on public.card_printings (set_id) where set_id is not null;

-- ── BEFORE INSERT / UPDATE OF set_name trigger ──────────────────────────────
-- Row-level (FOR EACH ROW). Postgres allows column-list `update of set_name`
-- with row-level triggers — the column-list/transition-tables conflict only
-- bites STATEMENT-level triggers. Single shared function for both INSERT and
-- UPDATE since the body is identical.

create or replace function public.card_printings_assign_set_id()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.set_name is not null then
    new.set_id := public.normalize_set_id(new.set_name);
  else
    new.set_id := null;
  end if;
  return new;
end;
$$;

comment on function public.card_printings_assign_set_id() is
  'BEFORE INSERT / BEFORE UPDATE OF set_name trigger function on card_printings. Auto-populates NEW.set_id from NEW.set_name via normalize_set_id().';

drop trigger if exists trg_card_printings_before_insert_set_set_id on public.card_printings;
create trigger trg_card_printings_before_insert_set_set_id
  before insert on public.card_printings
  for each row execute function public.card_printings_assign_set_id();

drop trigger if exists trg_card_printings_before_update_set_set_id on public.card_printings;
create trigger trg_card_printings_before_update_set_set_id
  before update of set_name on public.card_printings
  for each row execute function public.card_printings_assign_set_id();

-- ── Inline backfill ─────────────────────────────────────────────────────────
-- ~700k rows, single UPDATE. Bound to the migration transaction; since
-- supabase db push uses the pooler (not the API gateway), there's no
-- 60s gateway timeout to worry about. Lock duration is the cost; estimated
-- ~30s on Supabase's hardware. Runs after the BEFORE triggers are in place
-- so any concurrent INSERT during backfill gets correctly populated by
-- the trigger rather than relying on the backfill catching it.

update public.card_printings
  set set_id = public.normalize_set_id(set_name)
  where set_id is null and set_name is not null;

-- ── CHECK: set_id must equal normalize_set_id(set_name) ─────────────────────
-- Locks down the invariant the AFTER UPDATE trigger now depends on. Without
-- this CHECK, a service-role writer could `update card_printings set set_id =
-- 'wrong-slug' where ...` (the BEFORE trigger only fires on `update of set_name`,
-- not on direct set_id writes) — set_id would drift from set_name and the
-- AFTER trigger's set_id-based gate would refresh the wrong sets row.
--
-- normalize_set_id is IMMUTABLE so it's legal in a CHECK. Validated against
-- the just-backfilled rows; passes by construction (backfill used the same
-- expression).
--
-- Set-merge operator playbook (for PR 4 or any future "consolidate
-- duplicate sets" work):
--   1. UPDATE card_printings.set_name on the duplicate set's printings to the
--      canonical set_name. The BEFORE UPDATE OF set_name trigger will remap
--      set_id, the AFTER UPDATE trigger will refresh both sets rows, and
--      this CHECK will pass.
--   2. DELETE the now-empty duplicate from public.sets (the FK's ON DELETE
--      RESTRICT will prevent the delete unless step 1 reassigned every
--      printing).
-- Direct rewrites of set_id are not supported and the CHECK enforces this.

alter table public.card_printings
  add constraint card_printings_set_id_matches_set_name_chk
  check (
    (set_id is null and set_name is null)
    or set_id = public.normalize_set_id(set_name)
  );

-- ── Update PR 2 functions to use the new column ─────────────────────────────
-- refresh_sets_for_set_ids previously filtered card_printings by
-- `normalize_set_id(set_name) = any(p_set_ids)` — required the expression
-- index added by PR 2. Now we have `card_printings.set_id` as a regular
-- column, so we can filter by `cp.set_id = any(p_set_ids)` directly and use
-- the btree index added above.

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

  -- Delete sets whose set_id is in the input list and no longer has any
  -- backing card_printings rows.
  delete from public.sets s
  where s.set_id = any(p_set_ids)
    and not exists (
      select 1 from public.card_printings cp
      where cp.set_id = s.set_id
    );
  get diagnostics v_deleted = row_count;

  with by_set_lang as (
    select
      cp.set_id,
      cp.language,
      count(*) as n
    from public.card_printings cp
    where cp.set_id = any(p_set_ids)
      and cp.language is not null
    group by cp.set_id, cp.language
  ),
  top_lang as (
    select distinct on (set_id) set_id, language
    from by_set_lang
    order by set_id, n desc, language
  ),
  by_set as (
    select
      cp.set_id,
      min(cp.set_name) as set_name,
      min(cp.year) as year,
      count(*) as derived_card_count
    from public.card_printings cp
    where cp.set_id = any(p_set_ids)
    group by cp.set_id
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
    language           = coalesce(excluded.language, public.sets.language),
    year               = excluded.year,
    derived_card_count = excluded.derived_card_count,
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

-- The PR 2 AFTER trigger functions read `new_rows.set_name` /
-- `old_rows.set_name` and compute normalize_set_id() in the trigger body.
-- After this PR, set_id is populated by the BEFORE trigger, so the AFTER
-- triggers can read NEW / OLD set_id directly. Faster and avoids
-- redundant normalize_set_id calls per affected row.

create or replace function public.card_printings_after_insert_sync_sets()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_set_ids text[];
begin
  select array_agg(distinct set_id)
  into v_set_ids
  from new_rows
  where set_id is not null;
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
  -- UPDATE-trigger gate: only consider rows where set_id actually changed.
  -- The BEFORE INSERT/UPDATE OF set_name trigger keeps set_id consistent
  -- with set_name, so set_id IS DISTINCT FROM is the post-PR-3-correct
  -- equivalent of the pre-PR-3 set_name IS DISTINCT FROM gate.
  select array_agg(distinct sid)
  into v_set_ids
  from (
    select n.set_id as sid
    from new_rows n
    join old_rows o on o.id = n.id
    where n.set_id is distinct from o.set_id
      and n.set_id is not null
    union
    select o.set_id as sid
    from new_rows n
    join old_rows o on o.id = n.id
    where n.set_id is distinct from o.set_id
      and o.set_id is not null
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
  select array_agg(distinct set_id)
  into v_set_ids
  from old_rows
  where set_id is not null;
  if v_set_ids is not null then
    perform public.refresh_sets_for_set_ids(v_set_ids);
  end if;
  return null;
end;
$$;

-- ── Drop the now-redundant expression index ─────────────────────────────────
-- card_printings_normalize_set_id_idx (added in PR 2) was needed to make
-- `normalize_set_id(set_name) = any(p_set_ids)` filtering efficient. Now
-- that refresh_sets_for_set_ids filters by cp.set_id directly, the new
-- btree index card_printings_set_id_idx covers the lookup.

drop index if exists public.card_printings_normalize_set_id_idx;

-- ── Comment ─────────────────────────────────────────────────────────────────

comment on column public.card_printings.set_id is
  'FK to public.sets(set_id). Auto-populated from set_name by the trg_card_printings_before_insert_set_set_id and trg_card_printings_before_update_set_set_id row-level triggers. Source-of-truth remains set_name until set_id readers migrate (separate PRs); set_id is a denormalized cache that the triggers keep in sync. NULL only when set_name is NULL. Direct writes to set_id are rejected by card_printings_set_id_matches_set_name_chk — to remap a printing to a different set, UPDATE set_name (which cascades to set_id via the BEFORE trigger).';

-- ── Rollback (manual, NOT auto-applied) ─────────────────────────────────────
-- To revert (only safe before downstream readers depend on the column):
--
--   alter table public.card_printings drop constraint if exists card_printings_set_id_matches_set_name_chk;
--   drop trigger if exists trg_card_printings_before_update_set_set_id on public.card_printings;
--   drop trigger if exists trg_card_printings_before_insert_set_set_id on public.card_printings;
--   drop function if exists public.card_printings_assign_set_id();
--   alter table public.card_printings drop column if exists set_id;
--
--   -- Re-create the PR 2 expression index that was dropped:
--   create index card_printings_normalize_set_id_idx
--     on public.card_printings (public.normalize_set_id(set_name))
--     where set_name is not null;
--
--   -- Restore PR 2 trigger function bodies (refresh_sets_for_set_ids,
--   -- card_printings_after_*_sync_sets) from
--   -- 20260509150000_sets_refresh_and_sync_trigger.sql.
