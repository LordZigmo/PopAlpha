-- 20260301120000_derived_signals.sql
--
-- Adds PopAlpha-branded derived signal columns to card_metrics.
--
-- These are computed from provider_* fields already stored and
-- updated nightly by refresh_derived_signals() (next migration).
--
-- Columns:
--   signal_trend_strength  — stability-adjusted momentum
--                             = provider_trend_slope_7d / provider_cov_price_30d
--                             Higher = stronger, steadier upward move.
--
--   signal_breakout        — momentum × activity × room-to-run
--                             = trend_slope_7d × ln(1+changes_30d) × (1−range_position)
--                             Higher = price accelerating with room still to go.
--
--   signal_value_zone      — closeness to 30-day low (0–100)
--                             = (1 − provider_price_relative_to_30d_range) × 100
--                             100 = at the low end, 0 = at the high end.
--
--   signals_as_of_ts       — when the signals were last computed.

alter table public.card_metrics
  add column if not exists signal_trend_strength  numeric     null,
  add column if not exists signal_breakout        numeric     null,
  add column if not exists signal_value_zone      numeric     null,
  add column if not exists signals_as_of_ts       timestamptz null;
