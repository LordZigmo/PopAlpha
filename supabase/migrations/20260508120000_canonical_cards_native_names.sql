-- JP catalog ergonomics: store the original Japanese name for every
-- non-EN canonical_card alongside the existing English-translated name.
--
-- Background: the Scrydex JA importer prioritizes the English translation
-- for canonical_name + set_name because the matching pipeline, search
-- index, scanner OCR, and most code paths assume Latin-character text.
-- That choice is correct for those code paths but it threw away the
-- original Japanese names — which we now need for two new things:
--
--   1. The Yahoo! Auctions JP / Snkrdunk / Mercari JP scraper layer.
--      Constructing per-canonical-card precision queries requires the
--      raw Japanese (リザードン, not "Charizard") because the JP
--      marketplaces don't speak English.
--
--   2. Operator ergonomics for the (English-speaking) team. The
--      `/internal/admin/jp-explorer` view + the `scripts/jp-gloss.mjs`
--      CLI both surface JP↔EN side-by-side so non-Japanese-readers can
--      validate scraper matches and debug coverage gaps without leaving
--      the app.
--
-- Both columns are nullable (EN cards leave them NULL; non-JP language
-- adds in the future will populate them per row). Default NULL keeps
-- existing data intact; the backfill script (scripts/backfill-scrydex-
-- jp-native-names.mjs) re-fetches the JA Scrydex feed and stamps the
-- columns in place — non-disruptive, idempotent, no rows recreated.
--
-- Indexed only on canonical_name_native because that's what the
-- scraper's query constructor reads per-card (one read per card per
-- scrape). set_name_native is denormalized on canonical_cards (parity
-- with set_name); only ~212 distinct values across 20k+ rows so an
-- index there would be wasted bytes.
--
-- Rollback: ALTER TABLE canonical_cards DROP COLUMN canonical_name_native,
-- DROP COLUMN set_name_native; DROP INDEX IF EXISTS canonical_cards_native_name_idx;
-- The scraper layer can fall back to canonical_name (EN) if these are
-- absent — query precision degrades but nothing breaks.

ALTER TABLE public.canonical_cards
  ADD COLUMN IF NOT EXISTS canonical_name_native text,
  ADD COLUMN IF NOT EXISTS set_name_native text;

-- Partial index: we only ever look up native names when they exist, and
-- the EN-only catalog rows (~23k) shouldn't pay the index cost.
CREATE INDEX IF NOT EXISTS canonical_cards_native_name_idx
  ON public.canonical_cards (canonical_name_native)
  WHERE canonical_name_native IS NOT NULL;

COMMENT ON COLUMN public.canonical_cards.canonical_name_native IS
  'Original (non-translated) card name as returned by the source provider. '
  'Populated for non-EN languages; NULL for EN cards. Used by the JP-native '
  'scraper layer (Yahoo! Auctions JP, Snkrdunk, Mercari JP) to build '
  'precision search queries, and by /internal/admin/jp-explorer for '
  'JP↔EN ergonomics. Backfill: scripts/backfill-scrydex-jp-native-names.mjs.';

COMMENT ON COLUMN public.canonical_cards.set_name_native IS
  'Original (non-translated) set name as returned by the source provider. '
  'Same population/usage rules as canonical_name_native. Denormalized for '
  'fast per-row lookup during scraper query construction; only ~212 '
  'distinct values currently so consistency with set_name is enforced '
  'by the importer + backfill script, not by FK.';
