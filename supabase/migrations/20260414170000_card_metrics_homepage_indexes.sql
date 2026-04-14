-- Indexes for homepage queries and the refresh_card_metrics RPC.
--
-- ── Homepage queries (card_metrics + variant_metrics) ────────────────────────
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
-- ── refresh_card_metrics RPC (price_snapshots) ──────────────────────────────
--
-- The RPC scans price_snapshots twice:
--   1. all_prices_raw:            WHERE provider IN (...) AND observed_at >= now() - 30 days
--   2. provider_latest_by_ref_raw: WHERE provider IN (...) AND grade = 'RAW' AND observed_at >= now() - 72h
--
-- ── Timeseries writer (price_history_points) ────────────────────────────────
--
-- Checks "already written" state:
--   WHERE provider = ... AND source_window = 'snapshot' AND variant_ref IN (...)

-- ── card_metrics: homepage movers/drops/freshness ───────────────────────────

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

-- ── variant_metrics: homepage trending ──────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_variant_metrics_homepage_trending
  ON public.variant_metrics (provider_trend_slope_7d DESC)
  WHERE grade = 'RAW'
    AND provider IN ('SCRYDEX', 'POKEMON_TCG_API')
    AND provider_trend_slope_7d > 0
    AND provider_price_changes_count_30d >= 3;

-- ── price_snapshots: refresh_card_metrics RPC ───────────────────────────────

-- 30-day scan (all_prices_raw CTE): provider + observed_at range
CREATE INDEX IF NOT EXISTS idx_price_snapshots_provider_observed
  ON public.price_snapshots (provider, observed_at DESC);

-- 72-hour live price scan (provider_latest_by_ref_raw CTE): provider + grade + observed_at range
CREATE INDEX IF NOT EXISTS idx_price_snapshots_provider_grade_observed
  ON public.price_snapshots (provider, grade, observed_at DESC)
  WHERE grade = 'RAW';

-- ── price_history_points: timeseries "already written" check ────────────────

CREATE INDEX IF NOT EXISTS idx_price_history_points_provider_window_variant
  ON public.price_history_points (provider, source_window, variant_ref)
  WHERE source_window = 'snapshot';
