-- supersedes: 20260423055611_phase2d_canonical_view_v2.sql
-- supersedes: 20260516060000_public_price_history_snapshot_only.sql
-- supersedes: 20260516010000_snkrdunk_card_prices_jpy.sql
--
-- Raw price-history views are consumed by USD-only chart and portfolio
-- surfaces. Keep the public contract tight at the database boundary:
--   * RAW only, even though graded history refs also end in ::RAW
--   * USD only, so clients never render JPY/EUR as dollars
--   * printing_id must match the UUID embedded in variant_ref
--   * snapshot rows only; synthetic/history anchors stay internal

create or replace view public.public_price_history_canonical as
select
  ph.id,
  ph.canonical_slug,
  ph.variant_ref,
  ph.provider,
  ph.ts,
  ph.price,
  ph.currency,
  ph.source_window,
  ph.created_at
from public.price_history_points ph
where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
  and ph.source_window = 'snapshot'
  and ph.currency = 'USD'
  and ph.price > 0
  and ph.printing_id is not null
  and ph.variant_ref like '%::RAW'
  and ph.variant_ref not ilike '%::GRADED::%'
  and split_part(ph.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and split_part(ph.variant_ref, '::', 1)::uuid = ph.printing_id
  and ph.printing_id = public.preferred_canonical_raw_printing(ph.canonical_slug);

grant select on public.public_price_history_canonical to anon, authenticated;

create or replace view public.public_price_history_by_printing as
select
  ph.id,
  ph.canonical_slug,
  ph.printing_id,
  ph.finish,
  ph.provider_variant_token,
  ph.variant_ref,
  ph.provider,
  ph.ts,
  ph.price,
  ph.currency,
  ph.source_window,
  ph.created_at
from public.price_history_points ph
where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
  and ph.source_window = 'snapshot'
  and ph.currency = 'USD'
  and ph.price > 0
  and ph.printing_id is not null
  and ph.variant_ref like '%::RAW'
  and ph.variant_ref not ilike '%::GRADED::%'
  and split_part(ph.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and split_part(ph.variant_ref, '::', 1)::uuid = ph.printing_id;

grant select on public.public_price_history_by_printing to anon, authenticated;

-- Public display guard: if a RAW market price is wildly disconnected from
-- its own recent medians, hide the headline price until the underlying
-- card_metrics row is refreshed/repaired. This does not change the private
-- card_metrics table; it prevents obviously bad rollups (for example a
-- $200k RAW single with $45-$106 recent medians) from reaching public UI.
create or replace view public.public_card_metrics as
select
  cm.id,
  cm.canonical_slug,
  cm.printing_id,
  cm.grade,
  cm.median_7d,
  cm.median_30d,
  cm.low_30d,
  cm.high_30d,
  cm.trimmed_median_30d,
  cm.volatility_30d,
  cm.liquidity_score,
  cm.percentile_rank,
  cm.scarcity_adjusted_value,
  cm.active_listings_7d,
  cm.snapshot_count_30d,
  cm.provider_trend_slope_7d,
  cm.provider_trend_slope_30d,
  cm.provider_cov_price_7d,
  cm.provider_cov_price_30d,
  cm.provider_price_relative_to_30d_range,
  cm.provider_min_price_all_time,
  cm.provider_min_price_all_time_date,
  cm.provider_max_price_all_time,
  cm.provider_max_price_all_time_date,
  cm.provider_as_of_ts,
  cm.provider_price_changes_count_30d,
  cm.justtcg_price,
  case when cm.raw_market_price_outlier then null else cm.scrydex_price end as scrydex_price,
  case when cm.raw_market_price_outlier then null else cm.scrydex_price end as pokemontcg_price,
  coalesce(yjp_specific.price_usd, yjp_canonical.price_usd) as yahoo_jp_price,
  coalesce(yjp_specific.price_jpy, yjp_canonical.price_jpy) as yahoo_jp_price_jpy,
  coalesce(yjp_specific.sample_count, yjp_canonical.sample_count) as yahoo_jp_sample_count,
  coalesce(yjp_specific.observed_at, yjp_canonical.observed_at) as yahoo_jp_observed_at,
  coalesce(snk_specific.price_usd, snk_canonical.price_usd) as snkrdunk_price,
  coalesce(snk_specific.sample_count, snk_canonical.sample_count) as snkrdunk_sample_count,
  coalesce(snk_specific.observed_at, snk_canonical.observed_at) as snkrdunk_observed_at,
  coalesce(snk_specific.snkrdunk_product_code, snk_canonical.snkrdunk_product_code) as snkrdunk_product_code,
  case when cm.raw_market_price_outlier then null else cm.market_price end as market_price,
  case when cm.raw_market_price_outlier then null else cm.market_price_as_of end as market_price_as_of,
  case when cm.raw_market_price_outlier then null else cm.provider_compare_as_of end as provider_compare_as_of,
  case when cm.raw_market_price_outlier then 0 else cm.market_confidence_score end as market_confidence_score,
  case when cm.raw_market_price_outlier then true else cm.market_low_confidence end as market_low_confidence,
  case when cm.raw_market_price_outlier then 'OUTLIER_SUPPRESSED' else cm.market_blend_policy end as market_blend_policy,
  cm.market_provenance,
  case when cm.raw_market_price_outlier then null else cm.change_pct_24h end as change_pct_24h,
  case when cm.raw_market_price_outlier then null else cm.change_pct_7d end as change_pct_7d,
  cm.updated_at,
  cc.canonical_name_native,
  cc.set_name_native,
  cc.language,
  coalesce(snk_specific.price_jpy, snk_canonical.price_jpy) as snkrdunk_price_jpy
from (
  select
    base_cm.*,
    (
      base_cm.grade = 'RAW'
      and base_cm.market_price is not null
      and coalesce(base_cm.snapshot_count_30d, 0) >= 5
      and base_cm.market_price > (
        greatest(
          coalesce(nullif(base_cm.median_7d, 0), 0),
          coalesce(nullif(base_cm.median_30d, 0), 0),
          coalesce(nullif(base_cm.trimmed_median_30d, 0), 0),
          coalesce(nullif(base_cm.low_30d, 0), 0),
          1
        ) * 20
      )
    ) as raw_market_price_outlier
  from public.card_metrics base_cm
) cm
left join public.yahoo_jp_card_prices yjp_specific
  on yjp_specific.canonical_slug = cm.canonical_slug
 and yjp_specific.printing_id = cm.printing_id
 and yjp_specific.grade = cm.grade
left join public.yahoo_jp_card_prices yjp_canonical
  on yjp_canonical.canonical_slug = cm.canonical_slug
 and yjp_canonical.printing_id is null
 and yjp_canonical.grade = cm.grade
left join public.snkrdunk_card_prices snk_specific
  on snk_specific.canonical_slug = cm.canonical_slug
 and snk_specific.printing_id = cm.printing_id
 and snk_specific.grade = cm.grade
left join public.snkrdunk_card_prices snk_canonical
  on snk_canonical.canonical_slug = cm.canonical_slug
 and snk_canonical.printing_id is null
 and snk_canonical.grade = cm.grade
left join public.canonical_cards cc
  on cc.slug = cm.canonical_slug;

grant select on public.public_card_metrics to anon, authenticated;
