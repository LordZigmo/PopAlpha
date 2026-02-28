-- 20260301090000_card_metrics_v2.sql
--
-- Adds provider-namespaced analytics columns to card_metrics.
--
-- Columns are explicitly prefixed with "provider_" so:
--   - It's clear which values come from a provider vs our own computation
--   - Swapping providers only requires updating the ingest layer
--   - We can later add provider_2_trend_slope_7d without ambiguity
--
-- Written by sync-justtcg-prices AFTER refresh_card_metrics() runs,
-- so computed columns (median_7d, etc.) are already populated.
--
-- Shipping 4 core signals this weekend:
--   provider_trend_slope_7d             — momentum / direction of price
--   provider_cov_price_30d              — volatility (coeff. of variation)
--   provider_price_relative_to_30d_range — buy/sell positioning (0=at low, 1=at high)
--   provider_min_price_all_time         — all-time floor
--   provider_max_price_all_time         — all-time ceiling
--
-- Plus supporting context columns:
--   provider_trend_slope_30d
--   provider_cov_price_7d
--   provider_min_price_all_time_date
--   provider_max_price_all_time_date
--   provider_as_of_ts                   — when the provider snapshot was taken

alter table public.card_metrics
  add column if not exists provider_trend_slope_7d              numeric     null,
  add column if not exists provider_trend_slope_30d             numeric     null,
  add column if not exists provider_cov_price_7d                numeric     null,
  add column if not exists provider_cov_price_30d               numeric     null,
  add column if not exists provider_price_relative_to_30d_range numeric     null,
  add column if not exists provider_min_price_all_time          numeric     null,
  add column if not exists provider_min_price_all_time_date     timestamptz null,
  add column if not exists provider_max_price_all_time          numeric     null,
  add column if not exists provider_max_price_all_time_date     timestamptz null,
  add column if not exists provider_as_of_ts                    timestamptz null;
