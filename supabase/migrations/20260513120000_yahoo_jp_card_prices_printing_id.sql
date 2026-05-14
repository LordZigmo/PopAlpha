-- Yahoo! Auctions JP per-printing prices.
--
-- Background: when this table was first created (20260508140000), it was
-- keyed (canonical_slug, grade). That worked because the matcher only
-- emitted one "RAW" observation per canonical card, conflating HOLO and
-- REVERSE_HOLO sales for the same slug.
--
-- For modern Scarlet & Violet-era cards that have both a base print AND a
-- reverse-holo variant, those finishes trade at meaningfully different
-- prices — sometimes 5-10x apart. Showing a single conflated median in
-- the iOS hero is misleading: the user selects "Reverse Holo" in the
-- finish picker and still sees the base print's price.
--
-- 24% of cards currently written (788 of 3,289) have multiple printings
-- and exhibit this conflation. The matcher already has the inputs it
-- needs — lib/jp/glossary.mjs maps JP finish keywords (ホロ, リバース
-- ホロ, ノンホロ, ミラー) to finish enum values — it just hasn't been
-- wired to split observations by finish. This migration prepares the
-- storage layer for that work.
--
-- Schema change:
--   • Add nullable `printing_id` column referencing card_printings(id).
--   • Drop the old PK on (canonical_slug, grade); add a new one on
--     (canonical_slug, printing_id, grade) WITH NULLS NOT DISTINCT so
--     a canonical-level row (printing_id=NULL) can coexist with the
--     per-printing rows for the same slug.
--   • Re-create the public_card_metrics view to JOIN by both
--     canonical_slug AND printing_id, so iOS gets the right price for
--     whatever printing the user selected.
--
-- Compat shape:
--   • Existing rows keep their (slug, grade) data and get
--     printing_id=NULL. They stay valid as "canonical-level fallback"
--     prices, surfaced when the matcher can't confidently pick a
--     finish OR when iOS queries with printing_id IS NULL.
--   • The matcher will start writing per-printing rows in a follow-up
--     code change; until then, behavior is unchanged for users.

-- =============================================================================
-- 1. Add printing_id column + FK to card_printings
-- =============================================================================
ALTER TABLE public.yahoo_jp_card_prices
  ADD COLUMN IF NOT EXISTS printing_id uuid NULL
    REFERENCES public.card_printings(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.yahoo_jp_card_prices.printing_id IS
  'card_printings.id — null = canonical-level fallback (the matcher '
  'couldn''t confidently attribute observations to a specific finish, '
  'so the price is a blended median across all printings of this slug). '
  'Non-null = per-printing price, written when the matcher detects '
  'finish-specific markers in listing titles (リバホロ, ホロ, etc.).';

-- =============================================================================
-- 2. New natural key: (canonical_slug, printing_id, grade) WITH NULLS NOT
--    DISTINCT, expressed as a UNIQUE INDEX. Surrogate `id` UUID is the
--    primary key.
-- =============================================================================
-- Why we can't use a PK on (canonical_slug, printing_id, grade):
-- PostgreSQL requires PRIMARY KEY columns to be NOT NULL, even though
-- the underlying UNIQUE INDEX could allow NULL with the NULLS NOT
-- DISTINCT modifier. So we can't promote the natural-key index to PK.
--
-- The clean shape is a surrogate `id uuid` PK + a UNIQUE INDEX with
-- NULLS NOT DISTINCT on the natural-key triple. ON CONFLICT clauses
-- in the orchestrator + cron route reference the natural-key columns,
-- which resolves to the unique index — no functional change for
-- callers, just a different PK column under the hood.
--
-- NULLS NOT DISTINCT (PG 15+) makes the unique constraint treat NULL
-- printing_id values as equal, so a single canonical-level row
-- (printing_id NULL) for each (slug, grade) coexists with per-printing
-- rows without duplicate NULLs slipping through.
ALTER TABLE public.yahoo_jp_card_prices
  DROP CONSTRAINT IF EXISTS yahoo_jp_card_prices_pkey;
DROP INDEX IF EXISTS public.yahoo_jp_card_prices_pkey_idx;
DROP INDEX IF EXISTS public.yahoo_jp_card_prices_natural_key_idx;

ALTER TABLE public.yahoo_jp_card_prices
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.yahoo_jp_card_prices
  ADD CONSTRAINT yahoo_jp_card_prices_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX yahoo_jp_card_prices_natural_key_idx
  ON public.yahoo_jp_card_prices (canonical_slug, printing_id, grade)
  NULLS NOT DISTINCT;

-- Helpful secondary index for iOS-shaped lookups (slug-only without
-- printing_id) — these are common since the JP card detail view often
-- doesn't pick a printing until the user taps the selector.
CREATE INDEX IF NOT EXISTS yahoo_jp_card_prices_slug_idx
  ON public.yahoo_jp_card_prices (canonical_slug)
  WHERE printing_id IS NULL;

-- =============================================================================
-- 3. Re-create public_card_metrics view so the JOIN respects printing_id
-- =============================================================================
-- The view's role here is to expose yahoo_jp_* values to iOS at the
-- right granularity. iOS queries with `printing_id IS NULL` (canonical
-- card) OR `printing_id = '<uuid>'` (specific printing). The JOIN must
-- match the right row:
--
--   • If iOS requests canonical (cm.printing_id IS NULL):
--       → JOIN to yjp WHERE yjp.printing_id IS NULL (canonical fallback)
--   • If iOS requests a specific printing (cm.printing_id = X):
--       → JOIN to yjp WHERE yjp.printing_id = X (per-printing)
--       → If no per-printing row exists yet, fall back to the canonical
--         row so the user still sees a price (even if conflated).
--
-- We implement that with a LEFT JOIN to the per-printing row first,
-- then COALESCE in a second LEFT JOIN to the canonical-level row. The
-- view exposes price_usd / price_jpy / etc. via COALESCE.
--
-- IMPORTANT: per MEMORY.md feedback_sql_function_latest_body, the
-- latest active view definition before this migration is
-- 20260508150000_public_card_metrics_native_names.sql. We re-create
-- with EVERY column from that baseline plus the new per-printing
-- behavior on the yahoo_jp_* columns.

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
  -- yahoo_jp_* now resolves per-printing-with-canonical-fallback.
  -- yjp_specific is the per-printing row (matches cm.printing_id);
  -- yjp_canonical is the canonical-level fallback (printing_id NULL).
  -- COALESCE picks the per-printing price first, falls back to
  -- canonical, returns NULL if neither exists.
  COALESCE(yjp_specific.price_usd,     yjp_canonical.price_usd)     AS yahoo_jp_price,
  COALESCE(yjp_specific.price_jpy,     yjp_canonical.price_jpy)     AS yahoo_jp_price_jpy,
  COALESCE(yjp_specific.sample_count,  yjp_canonical.sample_count)  AS yahoo_jp_sample_count,
  COALESCE(yjp_specific.observed_at,   yjp_canonical.observed_at)   AS yahoo_jp_observed_at,
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
-- Per-printing yahoo_jp row (when iOS picks a specific finish)
LEFT JOIN public.yahoo_jp_card_prices yjp_specific
  ON  yjp_specific.canonical_slug = cm.canonical_slug
 AND  yjp_specific.printing_id    = cm.printing_id
 AND  yjp_specific.grade          = cm.grade
-- Canonical-level fallback (the conflated/blended median)
LEFT JOIN public.yahoo_jp_card_prices yjp_canonical
  ON  yjp_canonical.canonical_slug = cm.canonical_slug
 AND  yjp_canonical.printing_id IS NULL
 AND  yjp_canonical.grade          = cm.grade
LEFT JOIN public.canonical_cards cc
  ON  cc.slug = cm.canonical_slug;

GRANT SELECT ON public.public_card_metrics TO anon, authenticated;
