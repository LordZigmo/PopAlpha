-- v1.1 auto-learning: add `source` column to card_image_embeddings so
-- user-correction kNN anchors can be distinguished from catalog rows.
--
-- Background: lib/ai/card-image-embeddings.ts ensureCardImageEmbeddingsSchema()
-- adds this column lazily on first invocation, but that function only
-- runs when an /api/admin/scan-eval/promote call lands. We need the
-- column up before the very first such call so the v1.1 backfill
-- script (and any concurrent in-flight production correction) doesn't
-- 500. Idempotent ALTER + index — safe to apply alongside the lazy
-- migration.
--
-- Real-device 2026-04-30: backfilled 28 user_correction rows landed
-- after this migration was applied via Supabase MCP; commit captures
-- the same DDL in source control for fresh-environment reproducibility.

ALTER TABLE public.card_image_embeddings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'catalog';

CREATE INDEX IF NOT EXISTS card_image_embeddings_source_idx
  ON public.card_image_embeddings (source);

COMMENT ON COLUMN public.card_image_embeddings.source IS
  'Origin of this embedding: catalog (mirrored official catalog art, default), or user_correction (embedding produced from a user''s actual scan image when they corrected a mis-identification — v1.1 auto-learning, 2026-04-30). The kNN does not filter by source — both kinds participate as anchors — but the column lets us distinguish populations in metrics and selectively re-embed when bumping model_version.';
