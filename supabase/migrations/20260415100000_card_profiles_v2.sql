-- 20260415100000_card_profiles_v2.sql
--
-- Upgrade card_profiles for the batch AI summary pipeline:
--   1. Rename card_slug -> canonical_slug (aligns with iOS queries and all
--      other tables that reference canonical_cards.slug).
--   2. Add operational columns for refresh detection, cost tracking, and
--      source provenance.
--
-- The table is currently empty (no batch pipeline has ever populated it),
-- so the rename is non-destructive.

alter table public.card_profiles
  rename column card_slug to canonical_slug;

alter table public.card_profiles
  add column if not exists updated_at     timestamptz not null default now(),
  add column if not exists source         text        not null default 'llm',
  add column if not exists model_label    text        null,
  add column if not exists input_tokens   integer     null,
  add column if not exists output_tokens  integer     null,
  add column if not exists metrics_hash   text        null;

-- ── RPC: get cards that have market data but no profile ─────────────────────

create or replace function public.get_cards_missing_profiles(p_limit integer default 500)
returns table (
  canonical_slug   text,
  canonical_name   text,
  set_name         text,
  card_number      text,
  market_price     numeric,
  median_7d        numeric,
  median_30d       numeric,
  change_pct_7d    numeric,
  low_30d          numeric,
  high_30d         numeric,
  active_listings_7d integer,
  volatility_30d   numeric,
  liquidity_score  numeric
)
language sql stable
set search_path = public
as $$
  select
    cc.slug         as canonical_slug,
    cc.canonical_name,
    cc.set_name,
    cc.card_number,
    cm.market_price,
    cm.median_7d,
    cm.median_30d,
    cm.change_pct_7d,
    cm.low_30d,
    cm.high_30d,
    cm.active_listings_7d,
    cm.volatility_30d,
    cm.liquidity_score
  from public.canonical_cards cc
  join public.card_metrics cm
    on cm.canonical_slug = cc.slug
   and cm.printing_id is null
   and cm.grade = 'RAW'
  left join public.card_profiles cp
    on cp.canonical_slug = cc.slug
  where cp.canonical_slug is null
    and cm.market_price is not null
  order by cc.slug
  limit p_limit;
$$;

-- ── RPC: get cards whose profile is stale or hash-mismatched ────────────────

create or replace function public.get_cards_needing_profile_refresh(
  p_limit      integer default 500,
  p_stale_days integer default 14
)
returns table (
  canonical_slug   text,
  canonical_name   text,
  set_name         text,
  card_number      text,
  market_price     numeric,
  median_7d        numeric,
  median_30d       numeric,
  change_pct_7d    numeric,
  low_30d          numeric,
  high_30d         numeric,
  active_listings_7d integer,
  volatility_30d   numeric,
  liquidity_score  numeric,
  existing_hash    text
)
language sql stable
set search_path = public
as $$
  select
    cc.slug         as canonical_slug,
    cc.canonical_name,
    cc.set_name,
    cc.card_number,
    cm.market_price,
    cm.median_7d,
    cm.median_30d,
    cm.change_pct_7d,
    cm.low_30d,
    cm.high_30d,
    cm.active_listings_7d,
    cm.volatility_30d,
    cm.liquidity_score,
    cp.metrics_hash as existing_hash
  from public.card_profiles cp
  join public.canonical_cards cc
    on cc.slug = cp.canonical_slug
  join public.card_metrics cm
    on cm.canonical_slug = cc.slug
   and cm.printing_id is null
   and cm.grade = 'RAW'
  where cm.market_price is not null
    and (
      cp.updated_at < now() - (p_stale_days || ' days')::interval
      or cp.source = 'fallback'
    )
  order by cp.updated_at asc nulls first
  limit p_limit;
$$;

-- Lock down: service-role only (cron calls via dbAdmin)
revoke all on function public.get_cards_missing_profiles(integer) from public, anon, authenticated;
revoke all on function public.get_cards_needing_profile_refresh(integer, integer) from public, anon, authenticated;
