-- JP price-observation history table.
--
-- Background. yahoo_jp_card_prices and snkrdunk_card_prices both carry
-- a natural key of (canonical_slug, printing_id, grade) — each daily
-- pipeline run UPSERTs a fresh row in place. That keeps the "current
-- price" surface simple (one row per card+printing+grade) but discards
-- every prior observation, so the homepage cannot show "JP-native
-- change vs 24h ago" or "vs 7d ago".
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
-- printing_id is critical and must mirror the latest-price tables.
-- Yahoo!JP / Snkrdunk both emit per-printing rows (HOLO / Reverse Holo
-- / etc.) alongside a canonical-level fallback row (printing_id=NULL)
-- when the matcher can't confidently attribute the observation to a
-- specific finish. Dropping printing_id here would merge distinct
-- printings into the same time series and produce meaningless 24h/7d
-- deltas — accumulated rows could not be repaired without re-running
-- both sources, so the column has to exist before either pipeline
-- starts appending. See migration 20260513120000 for the latest-price
-- side of this design.
--
-- Independence note. This table mirrors the design of
-- yahoo_jp_card_prices (companion to card_metrics rather than a column
-- on it) so refresh_card_metrics() GC cannot touch JP-native rows.

CREATE TABLE IF NOT EXISTS public.jp_card_price_history (
  -- Surrogate PK. PostgreSQL requires PRIMARY KEY columns to be NOT
  -- NULL, so we cannot promote the natural-key tuple (which includes
  -- the nullable printing_id) to a PRIMARY KEY directly. Same shape as
  -- yahoo_jp_card_prices (migration 20260513120000): surrogate `id`
  -- PK plus a separate UNIQUE INDEX with NULLS NOT DISTINCT on the
  -- natural key tuple below.
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  canonical_slug text        NOT NULL REFERENCES public.canonical_cards(slug) ON DELETE CASCADE,
  -- Nullable on purpose: NULL = canonical-level fallback, non-NULL =
  -- per-printing observation. NULLS NOT DISTINCT on the natural-key
  -- index lets a single canonical-level row coexist with per-printing
  -- rows for the same (slug, grade, source, recorded_at) without
  -- duplicate-NULL leakage.
  printing_id    uuid        NULL REFERENCES public.card_printings(id) ON DELETE CASCADE,
  grade          text        NOT NULL DEFAULT 'RAW',
  source         text        NOT NULL CHECK (source IN ('yahoo_jp', 'snkrdunk')),
  price_jpy      numeric     NULL,
  price_usd      numeric     NULL,
  sample_count   integer     NULL,
  observed_at    timestamptz NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_card_price_history_pkey PRIMARY KEY (id)
);

-- Natural-key uniqueness with NULLS NOT DISTINCT (PG 15+) so the
-- canonical-level fallback (printing_id=NULL) and per-printing rows
-- coexist and each maintains its own independent time series. Mirrors
-- the yahoo_jp_card_prices natural-key shape so printing semantics
-- stay consistent across the latest-price tables and this history
-- table. The append cadence is one row per pipeline run, so even at
-- minute-level collisions are vanishingly unlikely; the uniqueness
-- constraint is here primarily so ON CONFLICT (canonical_slug,
-- printing_id, grade, source, recorded_at) DO NOTHING works in the
-- pipelines and a retried run is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS jp_card_price_history_natural_key_idx
  ON public.jp_card_price_history (canonical_slug, printing_id, grade, source, recorded_at)
  NULLS NOT DISTINCT;

-- Hot path: lookup latest + 24h-ago + 7d-ago rows per
-- (slug, printing_id, source). Per-printing time-series queries scan
-- this index and never need to read the heap when the projection list
-- stays narrow. recorded_at DESC matches the access pattern (most
-- recent observation first).
CREATE INDEX IF NOT EXISTS jp_card_price_history_lookup_idx
  ON public.jp_card_price_history (canonical_slug, printing_id, source, recorded_at DESC);

-- Sweep path: retention prune by recorded_at (delete rows older than
-- 90d).
CREATE INDEX IF NOT EXISTS jp_card_price_history_retention_idx
  ON public.jp_card_price_history (recorded_at DESC);

COMMENT ON TABLE public.jp_card_price_history IS
  'Append-only time series of JP-native sold-price observations from '
  'Yahoo! Auctions JP and Snkrdunk. Each daily pipeline run appends one '
  'row per (canonical_slug, printing_id, grade, source) before UPSERTing '
  'the latest-price companion tables (yahoo_jp_card_prices / '
  'snkrdunk_card_prices). Consumed by compute_jp_card_price_changes() '
  'to derive change_pct_24h and change_pct_7d for the JP homepage rails.';

COMMENT ON COLUMN public.jp_card_price_history.printing_id IS
  'card_printings.id — null = canonical-level fallback (the matcher '
  'couldn''t confidently attribute observations to a specific finish, '
  'so the price is a blended median across all printings of this slug). '
  'Non-null = per-printing observation. Mirrors the same column on '
  'yahoo_jp_card_prices / snkrdunk_card_prices. The natural-key index '
  'above uses NULLS NOT DISTINCT so a single canonical-level row '
  'coexists with per-printing rows for the same (slug, grade, source, '
  'recorded_at).';

COMMENT ON COLUMN public.jp_card_price_history.source IS
  'Pipeline that produced this observation. Constrained to '
  'yahoo_jp (run-yahoo-jp-pipeline.mjs) or snkrdunk '
  '(run-snkrdunk-pipeline.mjs). Joins keyed on '
  '(slug, printing_id, grade, source).';

COMMENT ON COLUMN public.jp_card_price_history.observed_at IS
  'Source-time of the pipeline aggregation (e.g. when Yahoo! median was '
  'computed). Distinct from recorded_at, which is the write timestamp '
  'into this table — the two can differ by hours if a pipeline run '
  'imports observations from earlier in the day.';

COMMENT ON COLUMN public.jp_card_price_history.recorded_at IS
  'When this row was written to Postgres. Part of the natural-key '
  'uniqueness index so multiple observations per '
  '(slug, printing_id, grade, source) coexist and so '
  'compute_jp_card_price_changes can order by recorded_at to find the '
  'nearest 24h-ago / 7d-ago snapshot.';

-- Anon read grant for the public API surface. RLS stays disabled on
-- this table (matching yahoo_jp_card_prices / snkrdunk_card_prices) —
-- price observations are non-PII and the homepage reads them through
-- anon.
GRANT SELECT ON public.jp_card_price_history TO anon, authenticated;
