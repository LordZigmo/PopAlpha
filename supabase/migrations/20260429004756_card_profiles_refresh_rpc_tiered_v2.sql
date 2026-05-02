-- Corrects the high-priority signal: liquidity_score is saturated at 100
-- for 99.97% of cards (same capping issue as active_listings_7d, noted in
-- the hash comments), so it is useless for tiering.
--
-- New signals:
--   abs(change_pct_7d) >= 10  — significant mover (top ~21% of cards)
--   canonical_slug in holdings — card is in at least one user portfolio;
--                                 these always stay fresh regardless of movement.
--
-- Everything else is low-priority: LLM profiles refresh only on hash change.
DROP FUNCTION IF EXISTS get_cards_needing_profile_refresh(integer, integer);

CREATE OR REPLACE FUNCTION get_cards_needing_profile_refresh(
  p_limit      integer,
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
  existing_source     text,
  is_high_priority    boolean
)
LANGUAGE sql STABLE AS $$
  WITH metrics AS (
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
      cp.source       AS existing_source,
      cp.updated_at,
      -- High-priority: significant mover OR in a user portfolio
      (
        ABS(COALESCE(cm.change_pct_7d, 0)) >= 10
        OR EXISTS (
          SELECT 1 FROM public.holdings h
          WHERE h.canonical_slug = cc.slug
        )
      ) AS is_high_priority,
      -- Current hash using JS-compatible rounding: FLOOR(x + 0.5) = Math.round(x)
      -- for all values including negative (JS rounds -0.5 toward +∞, not away from zero).
      LEFT(encode(sha256((
        COALESCE(FLOOR(cm.market_price  + 0.5)::bigint::text, '') || '|' ||
        COALESCE(FLOOR(cm.median_7d     + 0.5)::bigint::text, '') || '|' ||
        COALESCE(FLOOR(cm.change_pct_7d + 0.5)::bigint::text, '') || '|' ||
        COALESCE(FLOOR(cm.low_30d       + 0.5)::bigint::text, '') || '|' ||
        COALESCE(FLOOR(cm.high_30d      + 0.5)::bigint::text, '')
      )::bytea), 'hex'), 16) AS current_hash
    FROM public.card_profiles cp
    JOIN public.canonical_cards cc ON cc.slug = cp.canonical_slug
    JOIN public.card_metrics cm
      ON cm.canonical_slug = cc.slug
     AND cm.printing_id IS NULL
     AND cm.grade = 'RAW'
    WHERE cm.market_price IS NOT NULL
  )
  SELECT
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
    is_high_priority
  FROM metrics
  WHERE
    -- High-priority: refresh daily (fallback or stale LLM)
    (
      is_high_priority
      AND (
        existing_source = 'fallback'
        OR updated_at < now() - (p_stale_days || ' days')::interval
      )
    )
    -- Low-priority fallback: clear the backlog
    OR existing_source = 'fallback'
    -- Low-priority LLM: refresh only when price data moved
    OR (
      existing_source = 'llm'
      AND existing_hash IS DISTINCT FROM current_hash
    )
  ORDER BY
    CASE WHEN is_high_priority THEN 0 ELSE 1 END,
    CASE WHEN existing_source = 'fallback' THEN 0 ELSE 1 END,
    updated_at ASC NULLS FIRST
  LIMIT p_limit;
$$;
