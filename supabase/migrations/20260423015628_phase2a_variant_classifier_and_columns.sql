-- 20260422210000_phase2a_variant_classifier_and_columns.sql
--
-- Phase 2a: schema + classifier functions only. No data writes.
--
-- Goal: separate source-of-truth identity (variant_ref, carries what the
-- provider said) from our bucketing model (printing_id / finish, which we
-- derive). This lets queries filter by indexed columns instead of parsing
-- variant_ref, and lets us reclassify without mutating historical rows.
--
-- Context:
--   ~41% of slugs have multiple Scrydex provider_variant cohorts
--   (':normal' + ':reverseholofoil', etc.) under a single card_printings
--   row. Phase 1 (20260422200000) shipped a slug-dominant-cohort picker to
--   stop the user-visible zig-zag. Phase 2 models each finish as its own
--   card_printings row so the iOS finish pill can select reverse-holo
--   pricing directly.
--
-- Invariants this migration establishes:
--   - price_history_points.variant_ref stays untouched forever (provider
--     identity — if Scrydex gave us 'swsh12pt5-109:reverseholofoil', that
--     is what we preserve).
--   - printing_id / finish / provider_variant_token are DERIVED. If the
--     classifier is wrong, we re-run the backfill; we never rewrite
--     variant_ref.
--
-- This migration:
--   1. Adds three nullable columns on price_history_points.
--   2. Creates three IMMUTABLE classifier functions (pure SQL, no SET
--      search_path so the planner can inline them — they reference no
--      objects, so search_path locking provides no security benefit).
--   3. Adds a partial index keyed on (canonical_slug, printing_id, ts desc)
--      for the post-Phase-2 query path. Empty now; grows as backfill
--      populates printing_id.
--   4. Adds a CHECK constraint on finish (NOT VALID — no table scan now;
--      validated after Phase 2c backfill completes).
--
-- Deferred to subsequent migrations (NOT in this file):
--   - Phase 2b: insert missing card_printings rows for finishes the
--     classifier exposes but that have no existing row per slug. The 20
--     existing ALT_HOLO card_printings rows (discovered pre-migration) are
--     handled manually in 2c since the classifier folds ':altart' style
--     tokens into HOLO — they don't fit the derived mapping.
--   - Phase 2c: backfill printing_id / finish / provider_variant_token in
--     batches (resumable on printing_id IS NULL). Validates CHECK
--     constraint at the end.
--   - Phase 2d: rewrite public_price_history_canonical to filter on the
--     new columns; switch iOS/web callers.
--   - Phase 2e: add FK from printing_id -> card_printings(id) (NOT VALID,
--     then validate); enforce NOT NULL; add a non-partial FK support index
--     (the partial index here does not back cascade deletes through NULL
--     rows — which shouldn't exist after 2c, but NULL-aware planning).
--   - Phase 2f: update ingestion code to populate the columns inline.
--
-- Rollback: drop the three columns + three functions + the index + the
-- check constraint. Nothing else in the system references them until 2d.

-- 20260422210000_phase2a_variant_classifier_and_columns.sql
-- Phase 2a: schema + classifier functions only. No data writes.
-- See migration file for full context; this is the applied DDL.

alter table public.price_history_points
  add column if not exists printing_id uuid,
  add column if not exists finish text,
  add column if not exists provider_variant_token text;

comment on column public.price_history_points.printing_id is
  'Resolved card_printings.id. Derived via Phase 2 classifier. Nullable until 2c backfill completes.';
comment on column public.price_history_points.finish is
  'Derived finish classification. Mirrors lib/backfill/scrydex-variant-semantics.ts::detectNormalizedFinish — update both in lockstep.';
comment on column public.price_history_points.provider_variant_token is
  'Raw token from variant_ref. Only meaningful for provider = SCRYDEX.';

create index if not exists idx_price_history_points_slug_printing_ts
  on public.price_history_points (canonical_slug, printing_id, ts desc)
  where printing_id is not null;

alter table public.price_history_points
  drop constraint if exists price_history_points_finish_chk;

alter table public.price_history_points
  add constraint price_history_points_finish_chk
  check (finish is null or finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO','UNKNOWN'))
  not valid;

create or replace function public.variant_ref_base_printing_id(p_variant_ref text)
returns uuid
language sql
immutable
parallel safe
as $$
  select case
    when p_variant_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}::'
      then substring(p_variant_ref from 1 for 36)::uuid
    else null
  end;
$$;

create or replace function public.variant_ref_provider_token(p_variant_ref text)
returns text
language sql
immutable
parallel safe
as $$
  with parts as (
    select string_to_array(p_variant_ref, '::') as segs
  ),
  sized as (
    select segs, coalesce(array_length(segs, 1), 0) as seg_count
    from parts
  ),
  middle as (
    select segs, seg_count,
           case when seg_count = 3 then segs[2] else null end as mid
    from sized
  )
  select case
    when p_variant_ref is null then null
    when p_variant_ref like '%::GRADED::%' then null
    when p_variant_ref not like '%::RAW' then null
    when seg_count = 2 then null
    when seg_count = 3 and mid like '%:%' then
      split_part(mid, ':', array_length(string_to_array(mid, ':'), 1))
    when seg_count = 3 then mid
    else null
  end
  from middle;
$$;

create or replace function public.normalize_scrydex_finish(p_token text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_token is null then 'NON_HOLO'
    when p_token = '' then 'NON_HOLO'
    when lower(p_token) = 'unknown' then 'UNKNOWN'
    when lower(p_token) like '%reverse%' then 'REVERSE_HOLO'
    when lower(p_token) = 'normal' then 'NON_HOLO'
    when lower(p_token) like '%nonholo%' then 'NON_HOLO'
    when lower(p_token) like '%holo%' then 'HOLO'
    when lower(p_token) like '%foil%' then 'HOLO'
    else 'UNKNOWN'
  end;
$$;

revoke execute on function public.variant_ref_base_printing_id(text) from public, anon, authenticated;
revoke execute on function public.variant_ref_provider_token(text) from public, anon, authenticated;
revoke execute on function public.normalize_scrydex_finish(text) from public, anon, authenticated;
