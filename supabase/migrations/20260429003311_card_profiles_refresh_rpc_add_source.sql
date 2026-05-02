-- Expose cp.source in get_cards_needing_profile_refresh so the cron route
-- can bypass the hash-change filter for fallback profiles and always upgrade
-- them to real LLM summaries. Must DROP first because return type changes.
DROP FUNCTION IF EXISTS get_cards_needing_profile_refresh(integer, integer);

CREATE OR REPLACE FUNCTION get_cards_needing_profile_refresh(
  p_limit    integer,
  p_stale_days integer DEFAULT 1
)
RETURNS TABLE (
  canonical_slug      text,
  canonical_name      text,
  set_name            text,
  card_number         text,
  market_price        numeric,
  median_7d           numeric,
  median_30d          numeric,
  change_pct_7d       numeric,
  low_30d             numeric,
  high_30d            numeric,
  active_listings_7d  integer,
  volatility_30d      numeric,
  liquidity_score     numeric,
  existing_hash       text,
  existing_source     text
)
LANGUAGE sql STABLE AS $$
  SELECT
    cc.slug         AS canonical_slug,
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
    cp.metrics_hash AS existing_hash,
    cp.source       AS existing_source
  FROM public.card_profiles cp
  JOIN public.canonical_cards cc
    ON cc.slug = cp.canonical_slug
  JOIN public.card_metrics cm
    ON cm.canonical_slug = cc.slug
   AND cm.printing_id IS NULL
   AND cm.grade = 'RAW'
  WHERE cm.market_price IS NOT NULL
    AND (
      cp.updated_at < now() - (p_stale_days || ' days')::interval
      OR cp.source = 'fallback'
    )
  ORDER BY cp.updated_at ASC NULLS FIRST
  LIMIT p_limit;
$$;
