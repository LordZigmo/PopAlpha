-- 20260503120100_card_profiles_refresh_rpc_add_metadata.sql
--
-- Extend the card-profile selection RPCs to return rarity, year, and
-- is_digital so the deterministic fallback in lib/ai/card-profile-
-- summary.ts can produce collector-flavored content for cheap cards
-- (bulk / set-completion / vintage / digital) instead of a single
-- generic 3-sentence template that's identical for a $0.10 common
-- and a $0.10 obscure printing of a chase card.
--
-- supersedes: 20260429005519_card_profiles_refresh_rpc_tiered_v4.sql
--             (get_cards_needing_profile_refresh — latest body lifted
--              verbatim, three columns added, dispatch logic preserved)
-- supersedes: 20260415100000_card_profiles_v2.sql
--             (get_cards_missing_profiles — original body lifted,
--              three columns added)
--
-- New columns returned by both RPCs:
--   rarity      text  — picked one-per-slug, prefer language='EN'
--   year        int   — from canonical_cards.year
--   is_digital  bool  — from canonical_cards.is_digital
--
-- Rarity picker rationale: a canonical card can have multiple
-- printings (variants). They almost always share rarity (a Common is
-- a Common in NON_HOLO and REVERSE_HOLO alike), but to keep results
-- deterministic and English-biased we use a LATERAL with an explicit
-- ORDER BY: prefer EN language, then alphabetic finish (puts
-- ALT_HOLO/HOLO/NON_HOLO ahead of REVERSE_HOLO/UNKNOWN), then by id
-- to break ties.

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
  is_high_priority    boolean,
  rarity              text,
  year                int,
  is_digital          boolean
)
LANGUAGE sql STABLE AS $$
  WITH metrics AS (
    SELECT
      cc.slug         AS canonical_slug,
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
      LEFT(encode(sha256((
        COALESCE(FLOOR(cm.market_price  + 0.5)::bigint::text, '') || '|' ||
        COALESCE(FLOOR(cm.median_7d     + 0.5)::bigint::text, '') || '|' ||
        COALESCE(FLOOR(cm.change_pct_7d + 0.5)::bigint::text, '') || '|' ||
        COALESCE(FLOOR(cm.low_30d       + 0.5)::bigint::text, '') || '|' ||
        COALESCE(FLOOR(cm.high_30d      + 0.5)::bigint::text, '')
      )::bytea), 'hex'), 16) AS current_hash,
      pr.rarity AS rarity
    FROM public.card_profiles cp
    JOIN public.canonical_cards cc ON cc.slug = cp.canonical_slug
    JOIN public.card_metrics cm
      ON cm.canonical_slug = cc.slug
     AND cm.printing_id IS NULL
     AND cm.grade = 'RAW'
    LEFT JOIN LATERAL (
      SELECT p.rarity
      FROM public.card_printings p
      WHERE p.canonical_slug = cc.slug
      ORDER BY
        CASE WHEN p.language = 'EN' THEN 0 ELSE 1 END,
        p.finish,
        p.id
      LIMIT 1
    ) pr ON TRUE
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
    is_high_priority,
    rarity,
    year,
    is_digital
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

revoke all on function public.get_cards_needing_profile_refresh(integer, integer) from public, anon, authenticated;

-- ── get_cards_missing_profiles ──────────────────────────────────────────────

DROP FUNCTION IF EXISTS get_cards_missing_profiles(integer);

CREATE OR REPLACE FUNCTION public.get_cards_missing_profiles(p_limit integer DEFAULT 500)
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
  rarity              text,
  year                int,
  is_digital          boolean
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
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
    pr.rarity,
    cc.year,
    cc.is_digital
  FROM public.canonical_cards cc
  JOIN public.card_metrics cm
    ON cm.canonical_slug = cc.slug
   AND cm.printing_id IS NULL
   AND cm.grade = 'RAW'
  LEFT JOIN public.card_profiles cp
    ON cp.canonical_slug = cc.slug
  LEFT JOIN LATERAL (
    SELECT p.rarity
    FROM public.card_printings p
    WHERE p.canonical_slug = cc.slug
    ORDER BY
      CASE WHEN p.language = 'EN' THEN 0 ELSE 1 END,
      p.finish,
      p.id
    LIMIT 1
  ) pr ON TRUE
  WHERE cp.canonical_slug IS NULL
    AND cm.market_price IS NOT NULL
  ORDER BY cc.slug
  LIMIT p_limit;
$$;

revoke all on function public.get_cards_missing_profiles(integer) from public, anon, authenticated;
