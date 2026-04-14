-- Indexes for the homepage movers/drops and trending queries.
--
-- The homepage queries public_card_metrics (a view on card_metrics) with:
--   WHERE grade = 'RAW' AND printing_id IS NULL
--     AND market_price >= 1
--     AND market_price_as_of >= <72h cutoff>
--     AND (change_pct_24h > 0 OR change_pct_7d > 0)   -- movers
--     AND (change_pct_24h < 0 OR change_pct_7d < 0)   -- drops
--   ORDER BY market_price_as_of DESC, market_confidence_score DESC
--   LIMIT 240
--
-- The trending query hits public_variant_metrics (a view on variant_metrics):
--   WHERE provider IN ('SCRYDEX','POKEMON_TCG_API') AND grade = 'RAW'
--     AND provider_trend_slope_7d > 0
--     AND provider_price_changes_count_30d >= 3
--   ORDER BY provider_trend_slope_7d DESC
--   LIMIT 80
--
-- Without covering indexes these queries scan full tables and hit
-- Supabase's anon-role statement timeout (~8s).

-- Positive movers: cards with any upward price change in 24h or 7d
CREATE INDEX IF NOT EXISTS idx_card_metrics_homepage_positive
  ON public.card_metrics (market_price_as_of DESC, market_confidence_score DESC)
  WHERE grade = 'RAW'
    AND printing_id IS NULL
    AND market_price IS NOT NULL
    AND market_price >= 1
    AND (change_pct_24h > 0 OR change_pct_7d > 0);

-- Negative movers (drops): cards with any downward price change
CREATE INDEX IF NOT EXISTS idx_card_metrics_homepage_negative
  ON public.card_metrics (market_price_as_of DESC, market_confidence_score DESC)
  WHERE grade = 'RAW'
    AND printing_id IS NULL
    AND market_price IS NOT NULL
    AND market_price >= 1
    AND (change_pct_24h < 0 OR change_pct_7d < 0);

-- Freshness counts: cards with a recent market_price_as_of (for "prices refreshed today" KPI)
CREATE INDEX IF NOT EXISTS idx_card_metrics_homepage_freshness
  ON public.card_metrics (market_price_as_of DESC)
  WHERE grade = 'RAW'
    AND printing_id IS NULL
    AND market_price IS NOT NULL;

-- Trending: positive slope with activity from variant_metrics
CREATE INDEX IF NOT EXISTS idx_variant_metrics_homepage_trending
  ON public.variant_metrics (provider_trend_slope_7d DESC)
  WHERE grade = 'RAW'
    AND provider IN ('SCRYDEX', 'POKEMON_TCG_API')
    AND provider_trend_slope_7d > 0
    AND provider_price_changes_count_30d >= 3;
