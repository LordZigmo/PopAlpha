-- supersedes: 20260513150000_snkrdunk_card_prices.sql
--
-- Phase C-1b of the JPY-display thread: surface Snkrdunk prices as
-- "¥X,XXX ($X)" alongside Yahoo! JP tiles, instead of USD-only.
--
-- The original snkrdunk_card_prices migration explicitly skipped a
-- price_jpy column because Snkrdunk's English API serves USD directly:
--
--   "If we later scrape Snkrdunk's JP site to get native JPY, we can
--   ALTER TABLE to add those columns."
--
-- We're not scraping the JP site (yet). Instead, this migration adds
-- price_jpy + fx_rate_used as FX-derived columns — populated at write
-- time as `price_usd / JPY_TO_USD_RATE` so the value is stable per row
-- and reflects the rate at observation time. This mirrors the Yahoo!
-- JP path (yahoo_jp_card_prices.price_jpy + fx_rate_used) for
-- consistency, lets the public_card_metrics view expose
-- snkrdunk_price_jpy as a simple column passthrough, and avoids
-- view-level division (which would bake a constant rate into the
-- schema).
--
-- The JPY value here is an APPROXIMATION — not the seller's listed
-- yen value (Snkrdunk's English API doesn't expose that). When we
-- eventually scrape the JP site for the native value, the pipeline can
-- start writing the real number into the same column without a schema
-- change. fx_rate_used = NULL on rows where we have native JPY would
-- distinguish the two sources at query time.
--
-- Backfill: existing rows get price_jpy = price_usd / 0.0068 (matches
-- the JPY_TO_USD_RATE env default in run-yahoo-jp-daily/route.ts).
-- Future writes use the env value at write time.

-- =============================================================================
-- 1. Schema additions
-- =============================================================================
ALTER TABLE public.snkrdunk_card_prices
  ADD COLUMN IF NOT EXISTS price_jpy     numeric NULL,
  ADD COLUMN IF NOT EXISTS fx_rate_used  numeric NULL;

COMMENT ON COLUMN public.snkrdunk_card_prices.price_jpy IS
  'JPY-equivalent of price_usd at observation time. FX-derived from '
  'price_usd / fx_rate_used (Snkrdunk''s English API serves USD only; '
  'we do not have the seller''s native yen value). fx_rate_used is the '
  'JPY-per-USD rate applied at write time. When we scrape the JP site '
  'in a future PR for the actual native value, the pipeline can write '
  'a real value here without a schema change.';

COMMENT ON COLUMN public.snkrdunk_card_prices.fx_rate_used IS
  'JPY/USD rate used to derive price_jpy from price_usd at write time. '
  'Default 0.0068 (matches JPY_TO_USD_RATE env default). NULL on rows '
  'predating this migration where we did not capture a rate; the '
  'backfill below stamps 0.0068 for those.';

-- =============================================================================
-- 2. Backfill existing rows
-- =============================================================================
-- One-time backfill stamps the env default rate. Idempotent: only
-- updates rows where price_jpy is still NULL.
UPDATE public.snkrdunk_card_prices
SET
  price_jpy    = ROUND((price_usd / 0.0068)::numeric, 0),
  fx_rate_used = 0.0068
WHERE price_jpy IS NULL
  AND price_usd IS NOT NULL;

-- =============================================================================
-- 3. Recreate public_card_metrics view to expose snkrdunk_price_jpy
-- =============================================================================
-- CREATE OR REPLACE VIEW requires same columns + may append at the
-- end. We append snkrdunk_price_jpy after the existing column list so
-- existing consumers stay valid; iOS API and homepage data loaders
-- pick it up by name.
CREATE OR REPLACE VIEW public.public_card_metrics AS
 SELECT cm.id,
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
    COALESCE(yjp_specific.price_usd, yjp_canonical.price_usd) AS yahoo_jp_price,
    COALESCE(yjp_specific.price_jpy, yjp_canonical.price_jpy) AS yahoo_jp_price_jpy,
    COALESCE(yjp_specific.sample_count, yjp_canonical.sample_count) AS yahoo_jp_sample_count,
    COALESCE(yjp_specific.observed_at, yjp_canonical.observed_at) AS yahoo_jp_observed_at,
    COALESCE(snk_specific.price_usd, snk_canonical.price_usd) AS snkrdunk_price,
    COALESCE(snk_specific.sample_count, snk_canonical.sample_count) AS snkrdunk_sample_count,
    COALESCE(snk_specific.observed_at, snk_canonical.observed_at) AS snkrdunk_observed_at,
    COALESCE(snk_specific.snkrdunk_product_code, snk_canonical.snkrdunk_product_code) AS snkrdunk_product_code,
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
    cc.canonical_name_native,
    cc.set_name_native,
    cc.language,
    -- New 2026-05-16: Snkrdunk JPY-equivalent for "¥X,XXX ($X)" tile
    -- rendering. Mirror of yahoo_jp_price_jpy. Per-printing row wins
    -- over canonical fallback via the same COALESCE pattern.
    COALESCE(snk_specific.price_jpy, snk_canonical.price_jpy) AS snkrdunk_price_jpy
   FROM card_metrics cm
     LEFT JOIN yahoo_jp_card_prices yjp_specific ON yjp_specific.canonical_slug = cm.canonical_slug AND yjp_specific.printing_id = cm.printing_id AND yjp_specific.grade = cm.grade
     LEFT JOIN yahoo_jp_card_prices yjp_canonical ON yjp_canonical.canonical_slug = cm.canonical_slug AND yjp_canonical.printing_id IS NULL AND yjp_canonical.grade = cm.grade
     LEFT JOIN snkrdunk_card_prices snk_specific ON snk_specific.canonical_slug = cm.canonical_slug AND snk_specific.printing_id = cm.printing_id AND snk_specific.grade = cm.grade
     LEFT JOIN snkrdunk_card_prices snk_canonical ON snk_canonical.canonical_slug = cm.canonical_slug AND snk_canonical.printing_id IS NULL AND snk_canonical.grade = cm.grade
     LEFT JOIN canonical_cards cc ON cc.slug = cm.canonical_slug;
