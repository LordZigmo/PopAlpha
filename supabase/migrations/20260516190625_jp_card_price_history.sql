-- JP price-observation history table.
--
-- Background. yahoo_jp_card_prices and snkrdunk_card_prices both carry
-- PRIMARY KEY (canonical_slug, grade) — each daily pipeline run UPSERTs
-- a fresh row in place. That keeps the "current price" surface simple
-- (one row per card) but discards every prior observation, so the
-- homepage cannot show "JP-native change vs 24h ago" or "vs 7d ago".
--
-- This table is the missing time series. The two daily pipelines
-- (scripts/run-yahoo-jp-pipeline.mjs and scripts/run-snkrdunk-pipeline.mjs)
-- append a row here before each UPSERT against the latest-price tables.
-- A follow-on migration adds compute_jp_card_price_changes() which reads
-- this table to derive change_pct_24h_jp / change_pct_7d_jp; once that
-- ships, the JP signal-board rails (lib/data/homepage.ts JpRailBundle)
-- swap their data source from Scrydex's reflection to the JP-native
-- deltas computed here.
--
-- Independence note. This table mirrors the design of
-- yahoo_jp_card_prices (companion to card_metrics rather than a column on
-- it) so refresh_card_metrics() GC cannot touch JP-native rows.

CREATE TABLE IF NOT EXISTS public.jp_card_price_history (
  canonical_slug text        NOT NULL REFERENCES public.canonical_cards(slug) ON DELETE CASCADE,
  grade          text        NOT NULL DEFAULT 'RAW',
  source         text        NOT NULL CHECK (source IN ('yahoo_jp', 'snkrdunk')),
  price_jpy      numeric     NULL,
  price_usd      numeric     NULL,
  sample_count   integer     NULL,
  observed_at    timestamptz NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_slug, grade, source, recorded_at)
);

-- Hot path: lookup latest + 24h-ago + 7d-ago rows per (slug, source).
CREATE INDEX IF NOT EXISTS jp_card_price_history_lookup_idx
  ON public.jp_card_price_history (canonical_slug, source, recorded_at DESC);

-- Sweep path: retention prune by recorded_at (delete rows older than 90d).
CREATE INDEX IF NOT EXISTS jp_card_price_history_retention_idx
  ON public.jp_card_price_history (recorded_at DESC);

COMMENT ON TABLE public.jp_card_price_history IS
  'Append-only time series of JP-native sold-price observations from '
  'Yahoo! Auctions JP and Snkrdunk. Each daily pipeline run appends one '
  'row per (canonical_slug, grade, source) before UPSERTing the latest-'
  'price companion tables (yahoo_jp_card_prices / snkrdunk_card_prices). '
  'Consumed by compute_jp_card_price_changes() to derive change_pct_24h '
  'and change_pct_7d for the JP homepage rails.';

COMMENT ON COLUMN public.jp_card_price_history.source IS
  'Pipeline that produced this observation. Constrained to '
  'yahoo_jp (run-yahoo-jp-pipeline.mjs) or snkrdunk '
  '(run-snkrdunk-pipeline.mjs). Joins keyed on (slug, grade, source).';

COMMENT ON COLUMN public.jp_card_price_history.observed_at IS
  'Source-time of the pipeline aggregation (e.g. when Yahoo! median was '
  'computed). Distinct from recorded_at, which is the write timestamp '
  'into this table — the two can differ by hours if a pipeline run '
  'imports observations from earlier in the day.';

COMMENT ON COLUMN public.jp_card_price_history.recorded_at IS
  'When this row was written to Postgres. Part of the PK so multiple '
  'observations per (slug, grade, source) coexist and so '
  'compute_jp_card_price_changes can order by recorded_at to find the '
  'nearest 24h-ago / 7d-ago snapshot.';

-- Anon read grant for the public API surface. RLS stays disabled on
-- this table (matching yahoo_jp_card_prices / snkrdunk_card_prices) —
-- price observations are non-PII and the homepage reads them through
-- anon.
GRANT SELECT ON public.jp_card_price_history TO anon, authenticated;
