-- 20260303230000_signal_paywall_views.sql
--
-- Splits public views into free (no signal columns) and pro (full columns).
-- Signal columns on card_metrics: signal_trend_strength, signal_breakout, signal_value_zone, signals_as_of_ts
-- Signal columns on variant_metrics: signal_trend, signal_breakout, signal_value, signals_as_of_ts
--
-- public_card_metrics / public_variant_metrics — granted to anon+authenticated, no signals.
-- pro_card_metrics / pro_variant_metrics — no grant (service role only via dbAdmin).
--
-- CREATE OR REPLACE VIEW cannot drop columns, so we DROP + CREATE + re-GRANT.

-- ── public_card_metrics: drop & recreate without signal columns ────────────
DROP VIEW IF EXISTS public.public_card_metrics;
CREATE VIEW public.public_card_metrics AS
SELECT
  id, canonical_slug, printing_id, grade,
  median_7d, median_30d, low_30d, high_30d, trimmed_median_30d,
  volatility_30d, liquidity_score, percentile_rank, scarcity_adjusted_value,
  active_listings_7d, snapshot_count_30d,
  provider_trend_slope_7d, provider_trend_slope_30d,
  provider_cov_price_7d, provider_cov_price_30d,
  provider_price_relative_to_30d_range,
  provider_min_price_all_time, provider_min_price_all_time_date,
  provider_max_price_all_time, provider_max_price_all_time_date,
  provider_as_of_ts,
  provider_price_changes_count_30d,
  updated_at
FROM public.card_metrics;
GRANT SELECT ON public.public_card_metrics TO anon, authenticated;

-- ── public_variant_metrics: drop & recreate without signal columns ─────────
DROP VIEW IF EXISTS public.public_variant_metrics;
CREATE VIEW public.public_variant_metrics AS
SELECT
  id, canonical_slug, variant_ref, provider, grade, printing_id,
  provider_trend_slope_7d, provider_cov_price_30d,
  provider_price_relative_to_30d_range,
  provider_price_changes_count_30d, provider_as_of_ts,
  history_points_30d,
  updated_at
FROM public.variant_metrics;
GRANT SELECT ON public.public_variant_metrics TO anon, authenticated;

-- ── pro_card_metrics: full columns, service role only ──────────────────────
CREATE OR REPLACE VIEW public.pro_card_metrics AS SELECT * FROM public.card_metrics;
-- No GRANT to anon or authenticated. Only accessible via service role (dbAdmin).

-- ── pro_variant_metrics: full columns, service role only ───────────────────
CREATE OR REPLACE VIEW public.pro_variant_metrics AS SELECT * FROM public.variant_metrics;
-- No GRANT to anon or authenticated. Only accessible via service role (dbAdmin).
