-- 20260301100000_card_metrics_price_changes.sql
--
-- Adds provider_price_changes_count_30d to card_metrics.
--
-- This is an activity / liquidity proxy sourced from JustTCG's
-- priceChangesCount30d field (falls back to priceChangesCount7d).
-- Useful for distinguishing actively-traded cards from stale listings.

alter table public.card_metrics
  add column if not exists provider_price_changes_count_30d integer null;
