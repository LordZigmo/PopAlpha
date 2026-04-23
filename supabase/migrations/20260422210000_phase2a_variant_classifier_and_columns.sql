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

alter table public.price_history_points
  add column if not exists printing_id uuid,
  add column if not exists finish text,
  add column if not exists provider_variant_token text;

comment on column public.price_history_points.printing_id is
  'Resolved card_printings.id for this price point. Derived from variant_ref '
  'via the Phase 2 classifier (variant_ref_provider_token → '
  'normalize_scrydex_finish → lookup in card_printings). Nullable until '
  '2c backfill completes.';
comment on column public.price_history_points.finish is
  'Derived finish classification. Mirrors '
  'lib/backfill/scrydex-variant-semantics.ts::detectNormalizedFinish — '
  'update both in lockstep. Constrained to the same value set as '
  'card_printings.finish.';
comment on column public.price_history_points.provider_variant_token is
  'Raw token from variant_ref (e.g. "normal", "reverseholofoil", '
  '"firstedition"). Only meaningful for provider = ''SCRYDEX''. Null for '
  'canonical form <printing_id>::RAW and for non-Scrydex providers '
  '(JUSTTCG uses opaque provider ids, not finish tokens).';

-- Partial index: empty at creation (column is null on all rows), grows as
-- backfill sets printing_id. This is the query path Phase 2d switches to.
-- Partial keeps the index size bounded to resolved rows during rollout.
create index if not exists idx_price_history_points_slug_printing_ts
  on public.price_history_points (canonical_slug, printing_id, ts desc)
  where printing_id is not null;

-- Constrain finish to the same value set as card_printings.finish. NOT
-- VALID so it doesn't table-scan now; Phase 2c validates after backfill.
-- Constraint named to allow a targeted drop if the set ever expands.
alter table public.price_history_points
  add constraint price_history_points_finish_chk
  check (finish is null or finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO','UNKNOWN'))
  not valid;

--------------------------------------------------------------------------
-- Classifier functions.
--
-- IMMUTABLE + no `SET search_path`: the three functions reference no
-- tables / views / non-builtin operators, so they are safe to declare as
-- IMMUTABLE and don't need search_path locking (provides no security
-- benefit on a body that can't call user objects). Omitting SET allows
-- the planner to inline the function bodies into queries that call them,
-- which Phase 2d's view relies on for reasonable per-row cost on hot
-- paths like `.in("canonical_slug", slugs)`.
--------------------------------------------------------------------------

-- Extract the base printing_id UUID from the leading segment of variant_ref.
-- Returns null if the leading segment isn't a well-formed UUID (defensive:
-- shouldn't happen for any current writer, but guards against corrupt data).
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

-- Extract the provider_variant_token (the Scrydex finish suffix like
-- 'normal', 'reverseholofoil', 'firstedition', 'masterballreverseholofoil').
--
-- Input shapes:
--   - '<uuid>::RAW'                   (canonical, no token)      -> null
--   - '<uuid>::<sku>::RAW'            (provider-history w/ SKU)  -> tail of sku after ':'
--   - '<uuid>::<token>::RAW'          (provider-history raw tok) -> the token
--   - '<uuid>::GRADED::...::RAW'      (contaminated graded)      -> null (rejected)
--   - anything else                                              -> null
--
-- For non-Scrydex providers (e.g. JUSTTCG with opaque provider ids),
-- this returns whatever tail is present — callers should only trust the
-- return value when provider = 'SCRYDEX'. normalize_scrydex_finish()
-- folds unmatched tokens into UNKNOWN which is the safe default.
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

-- Normalize a provider_variant_token to one of our canonical finish values.
-- Mirrors lib/backfill/scrydex-variant-semantics.ts::detectNormalizedFinish.
-- This is the SQL half of the source of truth — update both in lockstep.
--
-- Returns: NON_HOLO | HOLO | REVERSE_HOLO | UNKNOWN | NULL.
--
-- Null / empty input returns NULL (not NON_HOLO) because the token is the
-- only signal Scrydex gives us about finish — a missing token means the
-- row is canonical form (<uuid>::RAW, typically JUSTTCG) and the finish
-- must be sourced from the owning card_printings row, not guessed here.
-- Phase 2c backfill branches on token-present vs token-absent accordingly.
--
-- Does NOT emit ALT_HOLO (20 card_printings rows exist with that finish;
-- Phase 2c handles them via direct card_printings lookup since they
-- cannot be derived from a provider_variant_token in a principled way).
create or replace function public.normalize_scrydex_finish(p_token text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_token is null then null
    when p_token = '' then null
    when lower(p_token) = 'unknown' then 'UNKNOWN'
    when lower(p_token) like '%reverse%' then 'REVERSE_HOLO'
    when lower(p_token) = 'normal' then 'NON_HOLO'
    when lower(p_token) like '%nonholo%' then 'NON_HOLO'
    when lower(p_token) like '%holo%' then 'HOLO'
    when lower(p_token) like '%foil%' then 'HOLO'
    else 'UNKNOWN'
  end;
$$;

-- Functions are called only from server-side views / backfill scripts that
-- run as postgres. Follow the allowlist pattern established in
-- 20260318104000_public_function_execute_allowlist.sql.
revoke execute on function public.variant_ref_base_printing_id(text)
  from public, anon, authenticated;
revoke execute on function public.variant_ref_provider_token(text)
  from public, anon, authenticated;
revoke execute on function public.normalize_scrydex_finish(text)
  from public, anon, authenticated;
