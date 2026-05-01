-- Allow CLIP and SigLIP rows (or any future model swap) to coexist for
-- the same (slug, variant_index, crop_type) tuple by including
-- model_version in the primary key. The KNN_QUERY in
-- /api/scan/identify already filters by model_version, so both
-- populations live side-by-side and the route picks the active one
-- based on the IMAGE_EMBEDDER_MODEL_VERSION constant.
--
-- This unblocks the 2026-04-30 SigLIP-2 migration: re-embeds the
-- entire 26k catalog under siglip2-base-patch16-384-v1 while keeping
-- the existing replicate-clip-vit-l-14-v1 rows for instant rollback.
-- Without model_version in the PK, the re-embed script's INSERT
-- would 23505 on every catalog row.
--
-- User-correction anchors (variant_index>=10000) hit the same
-- conflict — same slug, same variant_index, different model_version.
-- This migration unblocks both populations cleanly.
--
-- Idempotent: only swaps the PK when its current shape lacks
-- model_version. Pre-migration tables get the new constraint;
-- already-migrated tables no-op.

DO $$
DECLARE
  current_pk_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_pk_def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE c.contype = 'p'
    AND t.relname = 'card_image_embeddings';

  IF current_pk_def IS NOT NULL
     AND current_pk_def = 'PRIMARY KEY (canonical_slug, variant_index, crop_type)' THEN
    ALTER TABLE public.card_image_embeddings
      DROP CONSTRAINT card_image_embeddings_pkey;
    ALTER TABLE public.card_image_embeddings
      ADD CONSTRAINT card_image_embeddings_pkey
      PRIMARY KEY (canonical_slug, variant_index, crop_type, model_version);
  END IF;
END $$;
