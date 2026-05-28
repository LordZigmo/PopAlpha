-- Let trusted PriceCharting rows outrank legacy Scrydex outlier suppression.
-- The legacy suppressor still blocks Scrydex-only fallback prices, but it must
-- not hide an exact PriceCharting headline price.

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
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
          then ctrp.trusted_price_usd
        when cm.raw_market_price_outlier then null
        when ctrp.trust_status = 'SCRYDEX_ONLY_DEMOTED' then ctrp.trusted_price_usd
        when ctrp.trust_status = 'NO_TRUSTED_PRICE' then null
        else cm.market_price
      end
    when cm.raw_market_price_outlier then null
    else cm.market_price
  end as market_price,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
          then ctrp.trusted_price_as_of
        when cm.raw_market_price_outlier then null
        when ctrp.trust_status = 'SCRYDEX_ONLY_DEMOTED' then ctrp.trusted_price_as_of
        when ctrp.trust_status = 'NO_TRUSTED_PRICE' then null
        else cm.market_price_as_of
      end
    when cm.raw_market_price_outlier then null
    else cm.market_price_as_of
  end as market_price_as_of,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
          then ctrp.trusted_price_as_of
        when cm.raw_market_price_outlier then null
        when ctrp.trust_status = 'SCRYDEX_ONLY_DEMOTED' then ctrp.trusted_price_as_of
        when ctrp.trust_status = 'NO_TRUSTED_PRICE' then null
        else cm.provider_compare_as_of
      end
    when cm.raw_market_price_outlier then null
    else cm.provider_compare_as_of
  end as provider_compare_as_of,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status = 'PRICECHARTING_SCRYDEX_MATCH' then 96
        when ctrp.trust_status = 'PRICECHARTING_PRIMARY' then 92
        when ctrp.trust_status = 'PRICECHARTING_DIVERGED' then 85
        when cm.raw_market_price_outlier then 0
        when ctrp.trust_status = 'SCRYDEX_ONLY_DEMOTED' then 25
        when ctrp.trust_status = 'NO_TRUSTED_PRICE' then 0
        when cm.market_price is not null then least(coalesce(cm.market_confidence_score, 20), 25)
        else 0
      end
    when cm.raw_market_price_outlier then 0
    else cm.market_confidence_score
  end as market_confidence_score,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED') then false
        when cm.raw_market_price_outlier then true
        else true
      end
    when cm.raw_market_price_outlier then true
    else cm.market_low_confidence
  end as market_low_confidence,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
          then ctrp.trust_status
        when cm.raw_market_price_outlier then 'OUTLIER_SUPPRESSED'
        when ctrp.trust_status is not null then ctrp.trust_status
        when cm.market_price is not null then 'SCRYDEX_ONLY_DEMOTED'
        else 'NO_TRUSTED_PRICE'
      end
    when cm.raw_market_price_outlier then 'OUTLIER_SUPPRESSED'
    else cm.market_blend_policy
  end as market_blend_policy,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      jsonb_strip_nulls(jsonb_build_object(
        'trustedPriceSource',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
              then ctrp.trusted_price_source
            when cm.raw_market_price_outlier then null
            when ctrp.trusted_price_source is not null then ctrp.trusted_price_source
            when cm.market_price is not null then 'SCRYDEX'
            else null
          end,
        'trustStatus',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
              then ctrp.trust_status
            when cm.raw_market_price_outlier then 'NO_TRUSTED_PRICE'
            when ctrp.trust_status is not null then ctrp.trust_status
            when cm.market_price is not null then 'SCRYDEX_ONLY_DEMOTED'
            else 'NO_TRUSTED_PRICE'
          end,
        'priceConflictStatus',
          case
            when ctrp.trust_status = 'PRICECHARTING_DIVERGED' then 'DIVERGED'
            when ctrp.trust_status = 'PRICECHARTING_SCRYDEX_MATCH' then 'MATCHED'
            when ctrp.trust_status = 'SCRYDEX_ONLY_DEMOTED' then 'SCRYDEX_ONLY'
            else 'NONE'
          end,
        'relativeDeltaPct', ctrp.relative_delta_pct,
        'priceAsOf',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
              then ctrp.trusted_price_as_of
            when cm.raw_market_price_outlier then null
            when ctrp.trusted_price_as_of is not null then ctrp.trusted_price_as_of
            else cm.market_price_as_of
          end,
        'pricechartingAsOf', ctrp.pricecharting_as_of,
        'scrydexAsOf',
          case
            when ctrp.scrydex_as_of is not null then ctrp.scrydex_as_of
            when cm.raw_market_price_outlier then null
            else cm.market_price_as_of
          end,
        'movementHistorySource',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
             and (ctrp.pricecharting_change_pct_24h is not null or ctrp.pricecharting_change_pct_7d is not null)
              then 'PRICECHARTING'
            else null
          end,
        'pricechartingObservations7d', ctrp.pricecharting_observations_7d,
        'pricechartingHistoryPoints30d', ctrp.pricecharting_history_points_30d,
        'quarantineReason',
          case
            when ctrp.quarantine_reason is not null then ctrp.quarantine_reason
            when ctrp.trust_status is null and cm.market_price is not null and not cm.raw_market_price_outlier
              then 'MISSING_PRICECHARTING_EXACT_MATCH'
            else null
          end,
        'parityStatus',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
             and (ctrp.pricecharting_change_pct_24h is not null or ctrp.pricecharting_change_pct_7d is not null)
              then 'MATCH'
            else 'MISSING_PROVIDER'
          end,
        'sourceMix',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
              then jsonb_build_object('pricechartingWeight', 1, 'scrydexWeight', 0)
            when cm.market_price is not null and not cm.raw_market_price_outlier
              then jsonb_build_object('pricechartingWeight', 0, 'scrydexWeight', 1)
            else jsonb_build_object('pricechartingWeight', 0, 'scrydexWeight', 0)
          end,
        'sampleCounts7d',
          jsonb_build_object(
            'pricecharting', coalesce(ctrp.pricecharting_observations_7d, 0),
            'scrydex',
              case
                when coalesce(cm.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                  then (cm.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                else 0
              end
          ),
        'legacyScrydexProvenance', cm.market_provenance
      ))
    when cm.raw_market_price_outlier then coalesce(cm.market_provenance, '{}'::jsonb) || jsonb_build_object('parityStatus', 'MISSING_PROVIDER')
    else cm.market_provenance
  end as market_provenance,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
          then ctrp.pricecharting_change_pct_24h
        else null
      end
    when cm.raw_market_price_outlier then null
    else cm.change_pct_24h
  end as change_pct_24h,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
          then ctrp.pricecharting_change_pct_7d
        else null
      end
    when cm.raw_market_price_outlier then null
    else cm.change_pct_7d
  end as change_pct_7d,
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
  on cc.slug = cm.canonical_slug
left join public.canonical_trusted_raw_prices ctrp
  on ctrp.canonical_slug = cm.canonical_slug
 and ctrp.printing_id is not distinct from cm.printing_id;

grant select on public.public_card_metrics to anon, authenticated;
