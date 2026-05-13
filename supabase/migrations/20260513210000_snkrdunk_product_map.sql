-- Snkrdunk product-mapping catalog — Step C of the catalog-mapper
-- sequence (see PR #54's match-snkrdunk-canonical.mjs).
--
-- Purpose: persist the canonical_slug → Snkrdunk-product-ID mapping that
-- Step B v2 (forward-search) produces. Step D's orchestrator
-- (run-snkrdunk-pipeline.mjs) reads from this table instead of
-- requiring --slug + --product-code CLI args, so the cron at
-- /api/cron/run-snkrdunk-daily actually has work to do.
--
-- Why a dedicated map table (vs reusing snkrdunk_card_prices.snkrdunk_product_code):
--   - snkrdunk_card_prices is a TIME-SERIES table: it accumulates
--     per-grade price rows that get refreshed on every cron tick. Its
--     lifecycle is "expire/replace prices as they age."
--   - snkrdunk_product_map is a CATALOG table: one row per canonical
--     mapping decision. The mapping is permanent once established
--     (until the operator manually updates/rejects it).
--   - Mixing the two would mean the catalog mapping disappears every
--     time a price row gets garbage-collected. Separating them keeps
--     the mapping decision orthogonal to price data lifecycle.
--
-- mapping_status takes three values, mirroring Step B's classification:
--   - 'MATCHED'       Auto-accepted (name+number AND distinctive set
--                     evidence). Step D imports these.
--   - 'NEEDS_REVIEW'  Auto-flagged for operator confirmation
--                     (name+number with no distinctive set evidence —
--                     could be cross-set false positive). Step D
--                     SKIPS these until manually upgraded.
--   - 'REJECTED'      Operator manually marked as wrong. Step D
--                     skips these permanently.
--
-- For v0 we map ONE Snkrdunk product per canonical_slug. Per-printing
-- mapping (e.g., HOLO vs Reverse Holo as distinct Snkrdunk products)
-- is a future enhancement once we figure out the right discovery flow.

-- =============================================================================
-- The catalog table
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.snkrdunk_product_map (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  canonical_slug        text        NOT NULL REFERENCES public.canonical_cards(slug) ON DELETE CASCADE,
  snkrdunk_id           integer     NOT NULL,
  snkrdunk_product_code text        NOT NULL,
  snkrdunk_name         text        NULL,
  mapping_status        text        NOT NULL DEFAULT 'MATCHED',
  match_score           numeric     NULL,
  match_reasons         text[]      NULL,
  match_query           text        NULL,
  matched_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz NULL,
  reviewed_by           text        NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT snkrdunk_product_map_pkey PRIMARY KEY (id),
  CONSTRAINT snkrdunk_product_map_status_chk
    CHECK (mapping_status IN ('MATCHED', 'NEEDS_REVIEW', 'REJECTED'))
);

-- Natural-key uniqueness — one mapping per canonical_slug.
-- v0 scope: one Snkrdunk product per canonical_slug. If a canonical
-- has multiple printings on Snkrdunk (HOLO vs Reverse Holo as separate
-- products), we map the most-prominent one; per-printing fan-out is
-- a future enhancement.
CREATE UNIQUE INDEX IF NOT EXISTS snkrdunk_product_map_canonical_slug_uidx
  ON public.snkrdunk_product_map (canonical_slug);

-- Also unique by Snkrdunk product code so we don't accidentally
-- double-claim the same Snkrdunk product for two different canonicals
-- (which would surface a matcher bug).
CREATE UNIQUE INDEX IF NOT EXISTS snkrdunk_product_map_product_code_uidx
  ON public.snkrdunk_product_map (snkrdunk_product_code);

-- Status-filtered index for Step D's orchestrator lookup
-- ("give me all MATCHED rows ready for ingestion").
CREATE INDEX IF NOT EXISTS snkrdunk_product_map_status_idx
  ON public.snkrdunk_product_map (mapping_status, canonical_slug);

-- =============================================================================
-- Documentation
-- =============================================================================
COMMENT ON TABLE public.snkrdunk_product_map IS
  'Catalog mapping canonical_slug → Snkrdunk product. Populated by '
  'scripts/persist-snkrdunk-matches.mjs after scripts/match-snkrdunk-canonical.mjs '
  '(Step B v2 of the catalog mapper) produces a JSONL of matches. The orchestrator '
  '(run-snkrdunk-pipeline.mjs) reads MATCHED rows to know which Snkrdunk products '
  'to fetch prices for. Mapping is per-canonical_slug; per-printing fan-out is a '
  'future enhancement.';

COMMENT ON COLUMN public.snkrdunk_product_map.snkrdunk_id IS
  'Snkrdunk trading-card-id (integer; not zero-padded). The product '
  'code is the same id prefixed with "SW---", stored in '
  'snkrdunk_product_code for convenience.';

COMMENT ON COLUMN public.snkrdunk_product_map.mapping_status IS
  'Decision tier from Step B''s scorer:\n'
  '  MATCHED      — auto-accepted (name+number AND distinctive set evidence).\n'
  '                 Step D ingests these.\n'
  '  NEEDS_REVIEW — auto-flagged (name+number with only generic set tokens or\n'
  '                 no set tokens). Operator confirms before promoting to MATCHED.\n'
  '                 Step D SKIPS these.\n'
  '  REJECTED     — operator marked as wrong. Step D skips permanently.';

COMMENT ON COLUMN public.snkrdunk_product_map.match_score IS
  'Score from Step B''s scorer (0..1). Persisted for auditability — '
  'lets us re-tune the threshold later without re-running the full search.';

COMMENT ON COLUMN public.snkrdunk_product_map.match_reasons IS
  'The reasons array Step B''s scorer produced (e.g. ["+0.30 name-prefix", '
  '"+0.30 number-normalized (104)"]). Stored for auditability and review UX.';

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE public.snkrdunk_product_map ENABLE ROW LEVEL SECURITY;
-- No public policies — operator writes via service role; no anon reads.
-- The mapping is internal-only; consumers see Snkrdunk data via
-- snkrdunk_card_prices / public_card_metrics, not via this table.
