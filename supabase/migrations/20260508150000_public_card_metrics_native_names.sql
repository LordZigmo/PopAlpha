-- Recovered from prod migration history during drift cleanup 2026-05-08.
-- Originally applied via Supabase Dashboard SQL Editor; not committed to git
-- at the time, then surfaced when CI's supabase db push errored on
-- "Remote migration versions not found in local migrations directory".
-- Body matches what ran in prod, byte-for-byte (joined from
-- supabase_migrations.schema_migrations.statements).

-- Surface canonical_cards.canonical_name_native + set_name_native through
-- public_card_metrics so iOS card-detail can render the bilingual hero
-- (English name on top, Japanese underneath) in a single fetch instead
-- of round-tripping a second query to canonical_cards.
--
-- Why exposing through the view rather than a separate iOS fetch:
--   • iOS already reads public_card_metrics for the headline price and
--     the new yahoo_jp_* fields. Adding two more columns makes the view
--     the single source of truth for card-detail-view-relevant data.
--   • Avoids a 2nd Supabase REST round-trip on every card-detail open.
--   • Future non-iOS consumers (web detail page, internal admin
--     explorer) get the same benefit transparently.
--
-- This recreation matches the previous baseline (just-shipped
-- 20260508140000) byte-for-byte plus two LEFT-JOIN'd columns from
-- canonical_cards. Per MEMORY.md feedback_sql_function_latest_body,
-- the diff vs the latest baseline is exactly +2 columns:
--   canonical_name_native, set_name_native
-- All 40 columns from 20260508140000 are preserved.

DROP VIEW IF EXISTS public.public_card_metrics;

CREATE VIEW public.public_card_metrics AS
SELECT
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
  cm.scrydex_price,
  cm.scrydex_price AS pokemontcg_price,
  CASE WHEN cm.printing_id IS NULL THEN yjp.price_usd     ELSE NULL END AS yahoo_jp_price,
  CASE WHEN cm.printing_id IS NULL THEN yjp.price_jpy     ELSE NULL END AS yahoo_jp_price_jpy,
  CASE WHEN cm.printing_id IS NULL THEN yjp.sample_count  ELSE NULL END AS yahoo_jp_sample_count,
  CASE WHEN cm.printing_id IS NULL THEN yjp.observed_at   ELSE NULL END AS yahoo_jp_observed_at,
  cm.market_price,
  cm.market_price_as_of,
  cm.provider_compare_as_of,
  cm.market_confidence_score,
  cm.market_low_confidence,
  cm.market_blend_policy,
  cm.market_provenance,
  cm.change_pct_24h,
  cm.change_pct_7d,
  cm.updated_at,
  -- New: native (non-translated) names. Populated by
  -- scripts/backfill-scrydex-jp-native-names.mjs for JP-language cards;
  -- NULL on EN cards. iOS uses these to render bilingual hero text on
  -- JP cards.
  cc.canonical_name_native,
  cc.set_name_native,
  cc.language
FROM public.card_metrics cm
LEFT JOIN public.yahoo_jp_card_prices yjp
  ON  yjp.canonical_slug = cm.canonical_slug
 AND  yjp.grade           = cm.grade
LEFT JOIN public.canonical_cards cc
  ON  cc.slug = cm.canonical_slug;

GRANT SELECT ON public.public_card_metrics TO anon, authenticated;
