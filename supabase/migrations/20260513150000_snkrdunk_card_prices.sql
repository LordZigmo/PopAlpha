-- supersedes: 20260513120000_yahoo_jp_card_prices_printing_id.sql
--
-- Snkrdunk sold-price observations — second JP-native data source after
-- Yahoo! Auctions JP. Adds a dedicated companion table on the same
-- pattern (matching the Yahoo! shape so the view layer stays consistent)
-- and recreates public_card_metrics to expose snkrdunk_* columns
-- alongside the existing yahoo_jp_* ones.
--
-- WHY A SEPARATE TABLE (not columns on card_metrics):
-- Mirrors the design decision documented in
-- 20260508140000_card_metrics_yahoo_jp_price.sql for the same reasons:
-- refresh_card_metrics() GCs rows that lack recent SCRYDEX snapshots,
-- and Snkrdunk covers cards Scrydex doesn't (modern JP promos, S-P
-- cards, etc.). Per-source companion tables have their own lifecycle.
--
-- WHY NO price_jpy / fx_rate_used COLUMNS (unlike Yahoo!):
-- Snkrdunk's English API serves priceAmount in USD directly — listings
-- carry `currency: "USD"` and the JPY-source value isn't exposed via
-- /en/v1/. We store the USD figure as-is. If we later scrape Snkrdunk's
-- JP site to get native JPY, we can ALTER TABLE to add those columns
-- without churning the surface this migration creates.
--
-- WHY THE SAME (canonical_slug, printing_id, grade) NATURAL KEY:
-- Same reasoning as yahoo_jp_card_prices_printing_id — finish-specific
-- prices (HOLO vs Reverse Holo) need per-printing rows, and a
-- canonical-level rollup row (printing_id NULL) coexists for iOS
-- fallback. PostgreSQL forbids NULL columns in PRIMARY KEY, so we use
-- a surrogate `id uuid` PK + UNIQUE INDEX with NULLS NOT DISTINCT.

-- =============================================================================
-- 1. Companion table
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.snkrdunk_card_prices (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  canonical_slug        text        NOT NULL REFERENCES public.canonical_cards(slug) ON DELETE CASCADE,
  printing_id           uuid        NULL REFERENCES public.card_printings(id) ON DELETE CASCADE,
  grade                 text        NOT NULL DEFAULT 'RAW',
  price_usd             numeric     NULL,
  currency              text        NULL DEFAULT 'USD',
  sample_count          integer     NULL,
  snkrdunk_product_code text        NULL, -- e.g. "SW---91103" — for traceability + future re-fetch keying
  observed_at           timestamptz NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT snkrdunk_card_prices_pkey PRIMARY KEY (id)
);

-- Natural-key uniqueness — same NULLS NOT DISTINCT pattern as yahoo_jp
CREATE UNIQUE INDEX IF NOT EXISTS snkrdunk_card_prices_natural_key_idx
  ON public.snkrdunk_card_prices (canonical_slug, printing_id, grade)
  NULLS NOT DISTINCT;

-- Secondary indexes
CREATE INDEX IF NOT EXISTS snkrdunk_card_prices_slug_idx
  ON public.snkrdunk_card_prices (canonical_slug)
  WHERE printing_id IS NULL;

CREATE INDEX IF NOT EXISTS snkrdunk_card_prices_observed_at_idx
  ON public.snkrdunk_card_prices (observed_at DESC)
  WHERE observed_at IS NOT NULL;

-- Product-code lookup index — for the orchestrator's re-fetch flow that
-- finds rows to refresh by Snkrdunk product, not by canonical slug.
CREATE INDEX IF NOT EXISTS snkrdunk_card_prices_product_code_idx
  ON public.snkrdunk_card_prices (snkrdunk_product_code)
  WHERE snkrdunk_product_code IS NOT NULL;

-- =============================================================================
-- Column documentation
-- =============================================================================
COMMENT ON TABLE public.snkrdunk_card_prices IS
  'JP-native sold-price observations from Snkrdunk. Written by '
  'scripts/run-snkrdunk-pipeline.mjs. Independent lifecycle from '
  'card_metrics — not subject to refresh_card_metrics() GC. Joined into '
  'public_card_metrics view so the iOS API contract is unified.';

COMMENT ON COLUMN public.snkrdunk_card_prices.printing_id IS
  'card_printings.id — null = canonical-level fallback. Snkrdunk product '
  'codes (SW---<id>) map 1:1 to a specific printing, so per-printing '
  'rows should always be populated when the catalog-mapper resolves a '
  'printing. The canonical-level row is written in parallel for iOS view '
  'COALESCE fallback.';

COMMENT ON COLUMN public.snkrdunk_card_prices.grade IS
  'Card grade bucket — ''RAW'' or ''PSA10'' for v0 (matching the Yahoo! '
  'pipeline''s coverage). Other Snkrdunk conditions (PSA 9, BGS 10 BL/GL, '
  'ARS *) are dropped during aggregation until those buckets are added '
  'to the grade catalog. See lib/jp/snkrdunk-matcher.mjs mapConditionToGrade '
  'for the full mapping table.';

COMMENT ON COLUMN public.snkrdunk_card_prices.price_usd IS
  'Median sold price in USD as reported by Snkrdunk''s English API. '
  'Snkrdunk converts from JPY server-side; we accept the conversion '
  'as-is rather than redo it client-side (consistent with what the '
  'public-facing snkrdunk.com/en page shows).';

COMMENT ON COLUMN public.snkrdunk_card_prices.currency IS
  'Source currency for price_usd — always "USD" today since we scrape '
  'the English site. Future-proofs the schema against a JP-site scrape '
  'that would write JPY directly.';

COMMENT ON COLUMN public.snkrdunk_card_prices.sample_count IS
  'Number of distinct sold listings the median was computed from. '
  'Confidence indicator — n<3 is low confidence.';

COMMENT ON COLUMN public.snkrdunk_card_prices.snkrdunk_product_code IS
  'Snkrdunk product identifier — e.g. "SW---91103" for trading-card-id '
  '91103. Persisted so a re-fetch flow can find rows to refresh by '
  'product code without round-tripping through the canonical_slug map.';

COMMENT ON COLUMN public.snkrdunk_card_prices.observed_at IS
  'Source-time of the median calculation — when run-snkrdunk-pipeline.mjs '
  'scraped + aggregated listings. Distinct from updated_at (row write '
  'time). observed_at is what iOS surfaces as "last refreshed".';

-- =============================================================================
-- 2. RLS — public read-only via the view, direct table reads blocked
-- =============================================================================
ALTER TABLE public.snkrdunk_card_prices ENABLE ROW LEVEL SECURITY;
-- No policies = closed by default. Writes happen via service-role key
-- inside run-snkrdunk-pipeline.mjs which bypasses RLS.

-- =============================================================================
-- 3. Recreate public_card_metrics view to expose snkrdunk_* columns
-- =============================================================================
-- Baseline: the latest active body before this migration is in
-- 20260513120000_yahoo_jp_card_prices_printing_id.sql. We carry over
-- EVERY column it exposes (including the per-printing yahoo_jp_*
-- COALESCE pattern) and add four snkrdunk_* columns on the same
-- pattern.
--
-- Per MEMORY.md feedback_sql_function_latest_body: do not recreate
-- from an earlier baseline — that would silently drop the yahoo_jp_*
-- columns added in 20260513120000 and break iOS. The supersedes header
-- at the top of this file documents the lineage.

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
  -- yahoo_jp_* — per-printing first, canonical-level fallback.
  COALESCE(yjp_specific.price_usd,     yjp_canonical.price_usd)     AS yahoo_jp_price,
  COALESCE(yjp_specific.price_jpy,     yjp_canonical.price_jpy)     AS yahoo_jp_price_jpy,
  COALESCE(yjp_specific.sample_count,  yjp_canonical.sample_count)  AS yahoo_jp_sample_count,
  COALESCE(yjp_specific.observed_at,   yjp_canonical.observed_at)   AS yahoo_jp_observed_at,
  -- snkrdunk_* — same per-printing-first-then-canonical pattern.
  COALESCE(snk_specific.price_usd,     snk_canonical.price_usd)     AS snkrdunk_price,
  COALESCE(snk_specific.sample_count,  snk_canonical.sample_count)  AS snkrdunk_sample_count,
  COALESCE(snk_specific.observed_at,   snk_canonical.observed_at)   AS snkrdunk_observed_at,
  COALESCE(snk_specific.snkrdunk_product_code,
           snk_canonical.snkrdunk_product_code)                     AS snkrdunk_product_code,
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
  cc.language
FROM public.card_metrics cm
-- Yahoo! JP joins (per-printing then canonical-level)
LEFT JOIN public.yahoo_jp_card_prices yjp_specific
  ON  yjp_specific.canonical_slug = cm.canonical_slug
 AND  yjp_specific.printing_id    = cm.printing_id
 AND  yjp_specific.grade          = cm.grade
LEFT JOIN public.yahoo_jp_card_prices yjp_canonical
  ON  yjp_canonical.canonical_slug = cm.canonical_slug
 AND  yjp_canonical.printing_id IS NULL
 AND  yjp_canonical.grade          = cm.grade
-- Snkrdunk joins (per-printing then canonical-level)
LEFT JOIN public.snkrdunk_card_prices snk_specific
  ON  snk_specific.canonical_slug = cm.canonical_slug
 AND  snk_specific.printing_id    = cm.printing_id
 AND  snk_specific.grade          = cm.grade
LEFT JOIN public.snkrdunk_card_prices snk_canonical
  ON  snk_canonical.canonical_slug = cm.canonical_slug
 AND  snk_canonical.printing_id IS NULL
 AND  snk_canonical.grade          = cm.grade
LEFT JOIN public.canonical_cards cc
  ON  cc.slug = cm.canonical_slug;

GRANT SELECT ON public.public_card_metrics TO anon, authenticated;

-- =============================================================================
-- Known limitation — same as yahoo_jp at 20260508140000
-- =============================================================================
-- The view's LEFT JOIN starts from card_metrics, so a canonical_slug that
-- has ONLY snkrdunk data (no card_metrics row) won't appear in
-- public_card_metrics. Acceptable for v0 since every JP card already
-- catalog'd has card_metrics from the SCRYDEX ingestion. Vintage JP
-- cards without Scrydex coverage are a small-volume tail. The fix (when
-- needed) is to UNION (canonical_slug, grade) keys from both source
-- tables to ensure a row exists for every observed tuple — deferred
-- until post-backfill we measure actual coverage gaps.
