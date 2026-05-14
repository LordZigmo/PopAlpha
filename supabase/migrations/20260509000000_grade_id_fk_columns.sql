-- 20260509000000_grade_id_fk_columns.sql
--
-- PR 2 of the grade-catalog promotion. PR 1 (20260508180000) shipped the
-- catalog tables `grade_definitions` + `grade_aliases`. This migration
-- adds nullable `grade_id smallint` FK columns to every table that
-- carries a free-text `grade` column today, backfills existing rows via
-- the catalog/alias lookup, and installs BEFORE INSERT / UPDATE OF grade
-- triggers so future writes auto-populate `grade_id` and fail fast on
-- unknown grade strings.
--
-- Why nullable, why no NOT NULL constraint yet:
--   * Reader migration (PR 3) hasn't happened — bare `grade` is still
--     the truth source. Keeping `grade_id` nullable lets us roll back
--     this migration cleanly if needed without leaving the schema in
--     a half-state.
--   * The price_history backfill (5.25M rows) runs out-of-band via an
--     RPC defined here, not inline. Until that's complete, some rows
--     legitimately have `grade_id IS NULL` and writes against them
--     should not fail.
--   * NOT NULL ships as the final PR (after the bare TEXT column
--     itself is dropped).
--
-- Tables touched (7):
--   price_snapshots         229k rows  inline backfill
--   price_history           5.25M rows RPC backfill (out-of-band)
--   card_metrics            269k rows  inline backfill
--   variant_metrics         207k rows  inline backfill
--   holdings                4 rows     inline backfill
--   tracked_assets          7 rows     inline backfill
--   yahoo_jp_card_prices    217 rows   inline backfill
--
-- Sequencing note: variant_metrics has an existing CHECK constraint
-- (variant_metrics_printing_key_variant_ref_chk in
-- 20260416000000_downsample_price_history.sql:170) that binds the
-- bare `grade` text column to `variant_ref` shape. Adding `grade_id`
-- does not interact with that constraint — `grade` remains the truth
-- source for now. PR 3+ that migrates readers to grade_id will need
-- to either keep grade in lockstep or amend that CHECK.

-- ── resolve_grade_id ────────────────────────────────────────────────────────
-- Strict resolver: catalog code first, alias fallback, raises on unknown.
-- Used by the trigger function to fail fast on unknown grade strings at
-- write time. Drift becomes a hard error at the ingest boundary.

create or replace function public.resolve_grade_id(p_grade text)
returns smallint
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_grade_id smallint;
begin
  if p_grade is null then
    return null;
  end if;
  select grade_id into v_grade_id
  from public.grade_definitions
  where code = p_grade;
  if found then
    return v_grade_id;
  end if;
  select grade_id into v_grade_id
  from public.grade_aliases
  where alias = p_grade;
  if found then
    return v_grade_id;
  end if;
  raise exception 'Unknown grade ''%'' — not in grade_definitions.code or grade_aliases.alias. Add to catalog before inserting.', p_grade
    using errcode = 'check_violation';
end;
$$;

comment on function public.resolve_grade_id(text) is
  'Resolves a free-text grade string to a grade_definitions.grade_id. Tries direct catalog match first, then alias map. Raises check_violation on unknown grades so drift is caught at the write boundary.';

-- ── set_grade_id_from_grade ─────────────────────────────────────────────────
-- Shared trigger function. Each table gets its own trigger but they all
-- call this one function, which reads NEW.grade and sets NEW.grade_id.

create or replace function public.set_grade_id_from_grade()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.grade is not null then
    new.grade_id := public.resolve_grade_id(new.grade);
  else
    new.grade_id := null;
  end if;
  return new;
end;
$$;

comment on function public.set_grade_id_from_grade() is
  'BEFORE INSERT/UPDATE OF grade trigger function. Calls resolve_grade_id(NEW.grade) to populate NEW.grade_id. Fails the write on unknown grade strings.';

-- ── Pre-flight check ────────────────────────────────────────────────────────
-- Validate every distinct grade currently stored across the small tables can
-- be resolved by the catalog. This catches drift the audit might have missed
-- (e.g. a value written between the audit query and this migration's apply
-- time) before any column-add or backfill runs.
--
-- price_history is intentionally excluded — `select distinct grade` over its
-- 5.25M rows is a full sequential scan (no standalone index on grade) that
-- would extend the migration transaction unacceptably. The strict resolver
-- inside `backfill_price_history_grade_ids` will surface any drift in
-- price_history at backfill time, where it's an out-of-band, retry-friendly
-- failure rather than a CI-blocker.

do $$
declare
  bad_grade text;
begin
  for bad_grade in
    select distinct grade from public.price_snapshots where grade is not null
    union
    select distinct grade from public.card_metrics where grade is not null
    union
    select distinct grade from public.variant_metrics where grade is not null
    union
    select distinct grade from public.holdings where grade is not null
    union
    select distinct grade from public.tracked_assets where grade is not null
    union
    select distinct grade from public.yahoo_jp_card_prices where grade is not null
  loop
    perform public.resolve_grade_id(bad_grade);
  end loop;
end$$;

-- ── ALTER TABLE: add grade_id ───────────────────────────────────────────────
-- Nullable FK with `on delete restrict` — the catalog should not be deletable
-- while rows reference it. Index is partial (where grade_id is not null) so
-- it doesn't bloat during the price_history backfill window.

alter table public.price_snapshots
  add column if not exists grade_id smallint null
    references public.grade_definitions(grade_id) on delete restrict;
create index if not exists price_snapshots_grade_id_idx
  on public.price_snapshots (grade_id) where grade_id is not null;

alter table public.price_history
  add column if not exists grade_id smallint null
    references public.grade_definitions(grade_id) on delete restrict;
create index if not exists price_history_grade_id_idx
  on public.price_history (grade_id) where grade_id is not null;

-- Temporary inverse partial index to make the batched backfill efficient.
-- price_history.id is uuid (random), so `order by id` is non-monotonic and
-- the CTE in backfill_price_history_grade_ids would otherwise rescan-and-
-- skip increasingly many already-updated rows on each batch. This index
-- restricts the scan to just the unbackfilled rows, giving each batch
-- O(batch_size) cost regardless of progress.
--
-- The RPC drops this index automatically when backfill drains
-- (remaining_unmapped = 0). Once dropped, the regular price_history_grade_id_idx
-- (the inverse-direction partial added above) covers all forward queries.
create index if not exists price_history_grade_id_null_idx
  on public.price_history (id) where grade_id is null;

alter table public.card_metrics
  add column if not exists grade_id smallint null
    references public.grade_definitions(grade_id) on delete restrict;
create index if not exists card_metrics_grade_id_idx
  on public.card_metrics (grade_id) where grade_id is not null;

alter table public.variant_metrics
  add column if not exists grade_id smallint null
    references public.grade_definitions(grade_id) on delete restrict;
create index if not exists variant_metrics_grade_id_idx
  on public.variant_metrics (grade_id) where grade_id is not null;

alter table public.holdings
  add column if not exists grade_id smallint null
    references public.grade_definitions(grade_id) on delete restrict;
create index if not exists holdings_grade_id_idx
  on public.holdings (grade_id) where grade_id is not null;

alter table public.tracked_assets
  add column if not exists grade_id smallint null
    references public.grade_definitions(grade_id) on delete restrict;
create index if not exists tracked_assets_grade_id_idx
  on public.tracked_assets (grade_id) where grade_id is not null;

alter table public.yahoo_jp_card_prices
  add column if not exists grade_id smallint null
    references public.grade_definitions(grade_id) on delete restrict;
create index if not exists yahoo_jp_card_prices_grade_id_idx
  on public.yahoo_jp_card_prices (grade_id) where grade_id is not null;

-- ── Inline backfill (6 small tables) ────────────────────────────────────────
-- price_history (5.25M rows) is excluded — handled by RPC below.
-- All other tables fit in a single UPDATE comfortably.

update public.price_snapshots
  set grade_id = public.resolve_grade_id(grade)
  where grade_id is null and grade is not null;

update public.card_metrics
  set grade_id = public.resolve_grade_id(grade)
  where grade_id is null and grade is not null;

update public.variant_metrics
  set grade_id = public.resolve_grade_id(grade)
  where grade_id is null and grade is not null;

update public.holdings
  set grade_id = public.resolve_grade_id(grade)
  where grade_id is null and grade is not null;

update public.tracked_assets
  set grade_id = public.resolve_grade_id(grade)
  where grade_id is null and grade is not null;

update public.yahoo_jp_card_prices
  set grade_id = public.resolve_grade_id(grade)
  where grade_id is null and grade is not null;

-- ── Triggers ────────────────────────────────────────────────────────────────
-- Fire before insert and before update of the `grade` column. Auto-populate
-- grade_id from grade. Fail the write if grade can't be resolved.
--
-- Restricting to UPDATE OF grade (rather than UPDATE) means writes that
-- only touch other columns (price refreshes, signal recomputes) don't pay
-- the trigger cost.

drop trigger if exists trg_set_grade_id on public.price_snapshots;
create trigger trg_set_grade_id
  before insert or update of grade on public.price_snapshots
  for each row execute function public.set_grade_id_from_grade();

drop trigger if exists trg_set_grade_id on public.price_history;
create trigger trg_set_grade_id
  before insert or update of grade on public.price_history
  for each row execute function public.set_grade_id_from_grade();

drop trigger if exists trg_set_grade_id on public.card_metrics;
create trigger trg_set_grade_id
  before insert or update of grade on public.card_metrics
  for each row execute function public.set_grade_id_from_grade();

drop trigger if exists trg_set_grade_id on public.variant_metrics;
create trigger trg_set_grade_id
  before insert or update of grade on public.variant_metrics
  for each row execute function public.set_grade_id_from_grade();

drop trigger if exists trg_set_grade_id on public.holdings;
create trigger trg_set_grade_id
  before insert or update of grade on public.holdings
  for each row execute function public.set_grade_id_from_grade();

drop trigger if exists trg_set_grade_id on public.tracked_assets;
create trigger trg_set_grade_id
  before insert or update of grade on public.tracked_assets
  for each row execute function public.set_grade_id_from_grade();

drop trigger if exists trg_set_grade_id on public.yahoo_jp_card_prices;
create trigger trg_set_grade_id
  before insert or update of grade on public.yahoo_jp_card_prices
  for each row execute function public.set_grade_id_from_grade();

-- ── price_history backfill RPC ──────────────────────────────────────────────
-- 5.25M rows is too many to backfill inline (would extend the migration
-- transaction for minutes and lock readers). Instead, this migration ships
-- a batched RPC that the operator (or a cron) calls repeatedly until done.
--
-- Operator runbook:
--
--   1. Apply this migration (CI does it on merge to main).
--   2. Re-call until done=true:
--        select public.backfill_price_history_grade_ids();
--        select public.backfill_price_history_grade_ids(p_batch_size := 100000, p_max_batches := 100);
--   3. When the result has 'done': true, the RPC has auto-dropped the temp
--      inverse partial index (price_history_grade_id_null_idx).
--   4. Refresh planner stats — the column flipped from 100% NULL to 100% set,
--      and autoanalyze won't fire on column-only updates:
--        analyze public.price_history;
--   5. Sanity check: select count(*) from public.price_history where grade_id is null;
--
-- Returns jsonb with rows_updated, batches_run, remaining_unmapped, done.

create or replace function public.backfill_price_history_grade_ids(
  p_batch_size  int default 50000,
  p_max_batches int default 200
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_total_updated bigint := 0;
  v_batches_run   int    := 0;
  v_batch_count   int;
  v_remaining     bigint;
  v_iter          int;
begin
  if p_batch_size < 1 or p_max_batches < 1 then
    raise exception 'p_batch_size and p_max_batches must both be >= 1';
  end if;

  for v_iter in 1..p_max_batches loop
    with batch as (
      select id
      from public.price_history
      where grade_id is null and grade is not null
      order by id
      limit p_batch_size
    )
    update public.price_history ph
      set grade_id = public.resolve_grade_id(ph.grade)
      from batch
      where ph.id = batch.id;

    get diagnostics v_batch_count = row_count;

    if v_batch_count = 0 then
      exit;
    end if;

    v_total_updated := v_total_updated + v_batch_count;
    v_batches_run := v_iter;
  end loop;

  select count(*) into v_remaining
  from public.price_history
  where grade_id is null and grade is not null;

  -- Drop the temp inverse partial index once backfill is fully drained.
  -- Forward queries are covered by price_history_grade_id_idx; this index's
  -- only purpose was making the batched UPDATE efficient.
  if v_remaining = 0 then
    execute 'drop index if exists public.price_history_grade_id_null_idx';
  end if;

  return jsonb_build_object(
    'rows_updated',       v_total_updated,
    'batches_run',        v_batches_run,
    'remaining_unmapped', v_remaining,
    'done',               v_remaining = 0,
    'analyze_needed',     v_remaining = 0
  );
end;
$$;

comment on function public.backfill_price_history_grade_ids(int, int) is
  'Batched backfill of price_history.grade_id from price_history.grade via the catalog/alias lookup. Operator-callable. Returns rows_updated, batches_run, remaining_unmapped, and done flag. Re-call until done=true.';

-- Restrict to service role — anon/authenticated should not be able to run
-- bulk backfill RPCs.
revoke all on function public.backfill_price_history_grade_ids(int, int) from public;
revoke all on function public.backfill_price_history_grade_ids(int, int) from anon, authenticated;

-- ── Column comments ─────────────────────────────────────────────────────────
-- Document the new grade_id columns uniformly across all 7 tables. The body
-- is the same on every table because the column carries the same semantics
-- everywhere — keeping these explicit so future readers don't have to chase
-- the trigger function definition to know what populates it.

comment on column public.price_snapshots.grade_id is
  'FK to grade_definitions(grade_id). Auto-populated from `grade` text by the trg_set_grade_id trigger. Source of truth remains `grade` until PR 4 drops that column. NULL only on rows whose grade text predates this migration and have not yet been backfilled — see public.backfill_price_history_grade_ids() for the price_history-specific backfill.';

comment on column public.price_history.grade_id is
  'FK to grade_definitions(grade_id). Auto-populated from `grade` text by the trg_set_grade_id trigger. Source of truth remains `grade` until PR 4 drops that column. NULL on rows pre-dating the backfill RPC; run public.backfill_price_history_grade_ids() until done=true.';

comment on column public.card_metrics.grade_id is
  'FK to grade_definitions(grade_id). Auto-populated from `grade` text by the trg_set_grade_id trigger. Source of truth remains `grade` until PR 4 drops that column.';

comment on column public.variant_metrics.grade_id is
  'FK to grade_definitions(grade_id). Auto-populated from `grade` text by the trg_set_grade_id trigger. Source of truth remains `grade` until PR 4 drops that column. variant_metrics_printing_key_variant_ref_chk binds `grade` text to variant_ref shape — see PR 3 reader migration for grade_id integration.';

comment on column public.holdings.grade_id is
  'FK to grade_definitions(grade_id). Auto-populated from `grade` text by the trg_set_grade_id trigger. Source of truth remains `grade` until PR 4 drops that column. After this migration, INSERTs/UPDATEs with a grade string not in grade_definitions.code or grade_aliases.alias will fail with check_violation — see app/portfolio/PortfolioClient.tsx:40 (VALID_GRADES) for the UI-side allowed list.';

comment on column public.tracked_assets.grade_id is
  'FK to grade_definitions(grade_id). Auto-populated from `grade` text by the trg_set_grade_id trigger. Source of truth remains `grade` until PR 4 drops that column.';

comment on column public.yahoo_jp_card_prices.grade_id is
  'FK to grade_definitions(grade_id). Auto-populated from `grade` text by the trg_set_grade_id trigger. Source of truth remains `grade` until PR 4 drops that column.';

-- ── Rollback (manual, NOT auto-applied) ─────────────────────────────────────
-- If this migration needs to be reverted before PR 3 lands, run the
-- following as a NEW migration (do not edit this file):
--
--   drop function if exists public.backfill_price_history_grade_ids(int, int);
--
--   drop trigger if exists trg_set_grade_id on public.yahoo_jp_card_prices;
--   drop trigger if exists trg_set_grade_id on public.tracked_assets;
--   drop trigger if exists trg_set_grade_id on public.holdings;
--   drop trigger if exists trg_set_grade_id on public.variant_metrics;
--   drop trigger if exists trg_set_grade_id on public.card_metrics;
--   drop trigger if exists trg_set_grade_id on public.price_history;
--   drop trigger if exists trg_set_grade_id on public.price_snapshots;
--
--   drop function if exists public.set_grade_id_from_grade();
--   drop function if exists public.resolve_grade_id(text);
--
--   alter table public.yahoo_jp_card_prices drop column if exists grade_id;
--   alter table public.tracked_assets       drop column if exists grade_id;
--   alter table public.holdings             drop column if exists grade_id;
--   alter table public.variant_metrics      drop column if exists grade_id;
--   alter table public.card_metrics         drop column if exists grade_id;
--   alter table public.price_history        drop column if exists grade_id;
--   alter table public.price_snapshots      drop column if exists grade_id;
--
--   drop index if exists public.price_history_grade_id_null_idx;
--
-- Catalog tables (grade_definitions, grade_aliases) from PR 1 are
-- intentionally left intact — they're decoupled from this migration.
