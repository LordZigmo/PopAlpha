-- Re-queue low-dollar profile rows once they cross back ABOVE the floor.
--
-- PR #307 added a $2 low-dollar floor to the AI card-profile path: sub-$2 cards
-- get a deterministic "Low-dollar card" note persisted with source='low_dollar'
-- (a DISTINCT state from 'fallback' so they no longer churn through the
-- 'fallback' reselection below). Display for currently-<= $2 cards is handled
-- live by the read-time neutralizer in lib/card-profiles.ts.
--
-- Residual this fixes: a card that crosses the floor UPWARD ($1.60 -> $2.40,
-- $0.50 -> $5) keeps its persisted low_dollar note and never re-enters the
-- refresh queue, because the only hash-change reselection clause is
-- existing_source = 'llm'. So a now->$2 card can keep showing the low-dollar
-- note (its price + chart stay correct; only the AI summary is stale).
--
-- Fix: add ONE price-based reselection clause — re-queue any low_dollar row
-- whose market_price is now > $2 so it regenerates as a real LLM summary.
-- Price-based (not hash-based) so it catches every upward crosser, including
-- the band where the whole-dollar hash bucket is unchanged. Everything else in
-- the function body is byte-identical to the prior definition; ONLY the new
-- WHERE clause is added.
--
-- supersedes: 20260528184631_trustworthy_standard_price_display.sql

create or replace function public.get_cards_needing_profile_refresh(
  p_limit integer,
  p_stale_days integer default 1
)
returns table (
  canonical_slug text,
  canonical_name text,
  set_name text,
  card_number text,
  market_price numeric,
  median_7d numeric,
  median_30d numeric,
  change_pct_7d numeric,
  low_30d numeric,
  high_30d numeric,
  active_listings_7d integer,
  volatility_30d numeric,
  liquidity_score numeric,
  existing_hash text,
  existing_source text,
  is_high_priority boolean,
  rarity text,
  year int,
  is_digital boolean,
  market_price_display_state text,
  recent_market_signal_usd numeric,
  recent_market_signal_as_of timestamptz,
  recent_market_signal_delta_pct numeric,
  recent_market_signal_direction text
)
language sql stable
set search_path = public
as $$
  with metrics as (
    select
      cc.slug as canonical_slug,
      cc.canonical_name,
      cc.set_name,
      cc.card_number,
      cc.year,
      cc.is_digital,
      cm.market_price,
      cm.median_7d,
      cm.median_30d,
      cm.change_pct_7d,
      cm.low_30d,
      cm.high_30d,
      cm.active_listings_7d,
      cm.volatility_30d,
      cm.liquidity_score,
      cm.market_price_display_state,
      cm.recent_market_signal_usd,
      cm.recent_market_signal_as_of,
      cm.recent_market_signal_delta_pct,
      cm.recent_market_signal_direction,
      cp.metrics_hash as existing_hash,
      cp.source as existing_source,
      cp.updated_at,
      (
        abs(coalesce(cm.change_pct_7d, 0)) >= 10
        or exists (
          select 1 from public.holdings h
          where h.canonical_slug = cc.slug
        )
      ) as is_high_priority,
      coalesce(cm.market_price, 0) * abs(coalesce(cm.change_pct_7d, 0)) as dollar_move,
      left(encode(sha256((
        coalesce(floor(cm.market_price + 0.5)::bigint::text, '') || '|' ||
        coalesce(floor(cm.median_7d + 0.5)::bigint::text, '') || '|' ||
        coalesce(floor(cm.change_pct_7d + 0.5)::bigint::text, '') || '|' ||
        coalesce(floor(cm.low_30d + 0.5)::bigint::text, '') || '|' ||
        coalesce(floor(cm.high_30d + 0.5)::bigint::text, '')
      )::bytea), 'hex'), 16) as current_hash,
      pr.rarity as rarity
    from public.card_profiles cp
    join public.canonical_cards cc on cc.slug = cp.canonical_slug
    join public.public_card_metrics cm
      on cm.canonical_slug = cc.slug
     and cm.printing_id is null
     and cm.grade = 'RAW'
    left join lateral (
      select p.rarity
      from public.card_printings p
      where p.canonical_slug = cc.slug
      order by
        case when p.language = 'EN' then 0 else 1 end,
        p.finish,
        p.id
      limit 1
    ) pr on true
    where cm.market_price is not null
  )
  select
    canonical_slug,
    canonical_name,
    set_name,
    card_number,
    market_price,
    median_7d,
    median_30d,
    change_pct_7d,
    low_30d,
    high_30d,
    active_listings_7d,
    volatility_30d,
    liquidity_score,
    existing_hash,
    existing_source,
    is_high_priority,
    rarity,
    year,
    is_digital,
    market_price_display_state,
    recent_market_signal_usd,
    recent_market_signal_as_of,
    recent_market_signal_delta_pct,
    recent_market_signal_direction
  from metrics
  where
    (
      is_high_priority
      and (
        existing_source = 'fallback'
        or updated_at < now() - (p_stale_days || ' days')::interval
      )
    )
    or existing_source = 'fallback'
    or (
      existing_source = 'llm'
      and existing_hash is distinct from current_hash
    )
    -- NEW: a low-dollar note row whose price has crossed back ABOVE the $2
    -- floor needs a real LLM summary again. Price-based so it catches every
    -- upward crosser (incl. $1.60 -> $2.40, where the whole-dollar hash bucket
    -- is unchanged). Rows still <= $2 are NOT matched here, so they age out
    -- instead of churning. $2 mirrors LOW_DOLLAR_PROFILE_MAX_USD /
    -- ABUNDANT_RAW_CARD_MAX_USD in lib/pricing/displayed-market-price.ts.
    or (
      existing_source = 'low_dollar'
      and market_price > 2
    )
  order by
    case when is_high_priority then 0 else 1 end,
    case when is_high_priority then -dollar_move else 0 end,
    case when existing_source = 'fallback' then 0 else 1 end,
    updated_at asc nulls first
  limit p_limit;
$$;

revoke all on function public.get_cards_needing_profile_refresh(integer, integer) from public, anon, authenticated;
