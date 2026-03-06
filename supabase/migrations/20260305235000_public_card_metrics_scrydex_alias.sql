-- 20260305235000_public_card_metrics_scrydex_alias.sql
--
-- Expose SCRYDEX naming in public_card_metrics while preserving
-- pokemontcg_price as a compatibility alias.

drop view if exists public.public_card_metrics;
create view public.public_card_metrics as
select
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
  justtcg_price,
  scrydex_price,
  scrydex_price as pokemontcg_price,
  market_price,
  market_price_as_of,
  provider_compare_as_of,
  change_pct_24h,
  change_pct_7d,
  updated_at
from public.card_metrics;

grant select on public.public_card_metrics to anon, authenticated;
