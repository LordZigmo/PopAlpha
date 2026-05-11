-- Yahoo! Auctions JP scraped prices — surfaced through public_card_metrics
-- via a dedicated companion table.
--
-- DESIGN ITERATION (please read before deciding to "simplify" by moving
-- the columns onto card_metrics directly):
--
-- The first draft of this migration added yahoo_jp_price columns to
-- card_metrics, mirroring how scrydex_price and justtcg_price live
-- there. That breaks under the existing card_metrics lifecycle:
--
--   • refresh_card_metrics() and refresh_card_metrics_for_variants()
--     each end with `DELETE FROM public.card_metrics cm WHERE NOT
--     EXISTS (active SCRYDEX price_snapshots …)`.
--   • That GC fires from /api/cron/refresh-card-metrics and
--     lib/backfill/provider-pipeline-rollups.ts whenever the SCRYDEX
--     pipeline runs.
--   • Vintage JP cards (Base/Neo/Gym, Card-e era, etc.) frequently
--     have NO recent SCRYDEX price_snapshot — Scrydex doesn't cover
--     that segment, which is *the entire reason* the JP scraper
--     exists. Each cron tick would delete every row we'd just
--     written.
--
-- The fix is data-segregation: keep yahoo_jp_card_prices as its own
-- table with its own lifecycle (managed solely by
-- scripts/run-yahoo-jp-pipeline.mjs), and JOIN it into the
-- public_card_metrics view so the iOS API contract is unchanged.
--
-- Resulting separation of concerns:
--   card_metrics            — refreshed by SCRYDEX flow, deleted when
--                             SCRYDEX has no recent data. Source of
--                             truth for SCRYDEX-derived signals.
--   yahoo_jp_card_prices    — refreshed by run-yahoo-jp-pipeline.mjs,
--                             retained until *that* pipeline expires
--                             a row (separate retention policy, TBD).
--                             Source of truth for JP-native sold
--                             prices.
--   public_card_metrics     — read-only API contract. Joins both
--                             sources so iOS gets a unified row.
--
-- This pattern is also forward-compatible with future JP-native
-- sources (Snkrdunk, Mercari JP, Yahoo! Auctions JP for graded buckets)
-- — each provider gets its own table on the same shape, joined into
-- the view as additional columns, no card_metrics churn.

-- =============================================================================
-- The companion table
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.yahoo_jp_card_prices (
  canonical_slug   text        NOT NULL REFERENCES public.canonical_cards(slug) ON DELETE CASCADE,
  grade            text        NOT NULL DEFAULT 'RAW',
  price_usd        numeric     NULL,
  price_jpy        numeric     NULL,
  fx_rate_used     numeric     NULL,
  sample_count     integer     NULL,
  observed_at      timestamptz NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_slug, grade)
);

CREATE INDEX IF NOT EXISTS yahoo_jp_card_prices_observed_at_idx
  ON public.yahoo_jp_card_prices (observed_at DESC)
  WHERE observed_at IS NOT NULL;

COMMENT ON TABLE public.yahoo_jp_card_prices IS
  'JP-native sold-price observations from Yahoo! Auctions JP. Written by '
  'scripts/run-yahoo-jp-pipeline.mjs. Independent lifecycle from '
  'card_metrics — not subject to refresh_card_metrics() GC. Joined into '
  'public_card_metrics view so the API contract is unified.';
COMMENT ON COLUMN public.yahoo_jp_card_prices.grade IS
  'Card grade bucket — ''RAW'' for ungraded cards (today''s only-supported '
  'value), or ''PSA10'' / ''CGC10'' / ''BGS9.5'' / etc. once per-grade '
  'extraction ships. The orchestrator currently only writes RAW rows; '
  'graded buckets are a follow-up migration.';
COMMENT ON COLUMN public.yahoo_jp_card_prices.price_usd IS
  'Median raw-condition sold price, USD-converted via fx_rate_used at '
  'write time. Use lib/pricing/fx.ts (env JPY_TO_USD_RATE, default '
  '0.0068) as the canonical rate source.';
COMMENT ON COLUMN public.yahoo_jp_card_prices.price_jpy IS
  'Same as price_usd in native JPY. Preserved so the UI can show the '
  'original sold price without re-converting on the client, AND so a '
  'future re-conversion job can regenerate price_usd if FX rates drift '
  'without re-scraping. fx_rate_used + price_jpy together let any '
  'historical row be reconstructed.';
COMMENT ON COLUMN public.yahoo_jp_card_prices.fx_rate_used IS
  'JPY→USD rate applied at write time (price_usd = price_jpy * '
  'fx_rate_used). Storing this avoids auditability decay when the env '
  'JPY_TO_USD_RATE drifts: a later batch job can re-compute price_usd '
  'from the canonical price_jpy + a fresher rate, without re-scraping.';
COMMENT ON COLUMN public.yahoo_jp_card_prices.sample_count IS
  'Number of distinct sold listings the median was computed from. '
  'Confidence indicator — n<5 is low confidence.';
COMMENT ON COLUMN public.yahoo_jp_card_prices.observed_at IS
  'Source-time of the median calculation — when the orchestrator '
  'scraped + matched listings to produce price_usd/price_jpy. Distinct '
  'from updated_at, which tracks the row write time. observed_at is the '
  'right field to surface to users as "last refreshed".';

-- =============================================================================
-- RLS — public read-only, mirrors the card_metrics security posture
-- =============================================================================
-- card_metrics has ENABLE ROW LEVEL SECURITY since 20260414230000_security_hardening,
-- with the public view exposed read-only via a GRANT to anon/authenticated.
-- We apply the same pattern: RLS on, no policies = closed by default,
-- and rely on the view's SECURITY INVOKER + GRANT to anon as the read
-- channel. Direct table reads from clients are blocked.
--
-- Writes happen exclusively via the service-role key inside
-- run-yahoo-jp-pipeline.mjs, which bypasses RLS by design.
ALTER TABLE public.yahoo_jp_card_prices ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- Recreate public_card_metrics view to expose the JP columns
-- =============================================================================
-- IMPORTANT: latest active definition before this migration is in
-- 20260307113000_market_confidence_backtest_alerts.sql. That file added
-- market_confidence_score / market_low_confidence / market_blend_policy /
-- market_provenance which iOS fetchCardMetrics queries today. Recreating
-- the view from any earlier baseline would silently drop those columns
-- and break iOS for every card. This recreation includes EVERY column
-- the previous version exposed plus our four yahoo_jp_* additions.
--
-- See MEMORY.md "feedback_sql_function_latest_body" — recreated view
-- definitions must be diffed against the latest active body, not the
-- original creation.
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
  -- yahoo_jp_* surfaced only on the canonical (printing_id IS NULL)
  -- row since yahoo_jp_card_prices has no per-printing dimension yet.
  -- Per-printing graded buckets ship in a follow-up migration.
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
  cm.updated_at
FROM public.card_metrics cm
LEFT JOIN public.yahoo_jp_card_prices yjp
  ON  yjp.canonical_slug = cm.canonical_slug
 AND  yjp.grade           = cm.grade;

GRANT SELECT ON public.public_card_metrics TO anon, authenticated;

-- =============================================================================
-- Known limitation — surfaced for follow-up
-- =============================================================================
-- The LEFT JOIN starts from card_metrics, so a canonical_slug that has
-- ONLY yahoo_jp data and NO card_metrics row at all (no Scrydex history,
-- never matched) will not appear in public_card_metrics. For Day 3 v0
-- this is acceptable: every JP card with prior SCRYDEX coverage already
-- has a card_metrics row that the JOIN catches. Vintage JP cards
-- without ANY Scrydex history are a small-volume tail.
--
-- The follow-up fix (when needed) is to UNION the keys from both
-- sources so a row exists for any (slug, grade) tuple in either table.
-- Deferred until we measure actual coverage gaps post-backfill.
