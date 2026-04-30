-- Tiered refresh logic for card profiles.
--
-- Tier 1 — high-priority (daily):
--   abs(change_pct_7d) >= 10  — significant movers (~21% of catalog)
--   OR canonical_slug in holdings — card owned by at least one user.
--   Refreshed every p_stale_days regardless of hash change.
--   Sorted by dollar_move (price × abs_pct) DESC so expensive movers
--   surface first. A $50 card moving 15% ($7.50) ranks above a $0.05
--   bulk card moving 150% ($0.075).
--   Note: liquidity_score is saturated at 100 for 99.97% of cards
--   (same capping issue as active_listings_7d) and is NOT used here.
--
-- Tier 2 — low-priority (price-movement only):
--   Everything else. LLM profiles refreshed only when the metrics hash
--   changes (computed in SQL using FLOOR(x + 0.5) to match JS Math.round,
--   including the -0.5 boundary where JS rounds toward +∞).
--
-- Fallbacks always process; within each tier fallbacks come before stale LLM.
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
      (
        ABS(COALESCE(cm.change_pct_7d, 0)) >= 10
        OR EXISTS (
          SELECT 1 FROM public.holdings h
          WHERE h.canonical_slug = cc.slug
        )
      ) AS is_high_priority,
      -- Dollar move magnitude: price × abs(change_pct_7d). Used as the
      -- within-tier sort key so expensive movers rank above cheap volatile bulk.
      COALESCE(cm.market_price, 0) * ABS(COALESCE(cm.change_pct_7d, 0))
        AS dollar_move,
      -- Current hash using JS-compatible rounding: FLOOR(x + 0.5) = Math.round(x)
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
    (
      is_high_priority
      AND (
        existing_source = 'fallback'
        OR updated_at < now() - (p_stale_days || ' days')::interval
      )
    )
    OR existing_source = 'fallback'
    OR (
      existing_source = 'llm'
      AND existing_hash IS DISTINCT FROM current_hash
    )
  ORDER BY
    -- High-priority tier first
    CASE WHEN is_high_priority THEN 0 ELSE 1 END,
    -- Within high-priority: largest dollar move first (homepage-relevant cards surface fastest)
    CASE WHEN is_high_priority THEN -dollar_move ELSE 0 END,
    -- Low-priority: fallbacks before stale LLM
    CASE WHEN existing_source = 'fallback' THEN 0 ELSE 1 END,
    updated_at ASC NULLS FIRST
  LIMIT p_limit;
$$;
