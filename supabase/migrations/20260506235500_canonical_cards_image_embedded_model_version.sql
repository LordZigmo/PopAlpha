-- canonical_cards.image_embedded_model_version
--
-- Closes the model-cutover bug surfaced 2026-05-06: the embed cron's
-- claim filter at app/api/cron/refresh-card-image-embeddings/route.ts
-- was `image_embedded_at IS NULL` — model-version-agnostic. Once a row
-- got stamped under CLIP, the cron silently skipped it forever, even
-- after IMAGE_EMBEDDER_VARIANT was flipped to SigLIP. Result: 749
-- canonical rows had CLIP rows in card_image_embeddings but zero SigLIP
-- rows — invisible to the SigLIP-filtered kNN, including all 9
-- base-set-2 scanner-eval images that scored 0/9 across every mode.
--
-- Fix: track WHICH model_version stamped the row. The cron's claim
-- filter then becomes "stamp is null OR stamp != active variant",
-- which correctly re-claims rows under any future model swap.
--
-- Backfill strategy:
--   The truth-of-record for "what's currently embedded" is the
--   card_image_embeddings table (in the same DB), not the cron's
--   bookkeeping column. So we backfill the new column FROM that table
--   — pulling the model_version of each slug's primary (full / vi=0)
--   embedding. Slugs with SigLIP rows get stamped 'siglip2-...';
--   slugs with only CLIP rows get stamped 'replicate-clip-...';
--   slugs with no rows at all stay NULL (the cron will claim them).
--
-- After this migration + the cron code change lands, running the cron
-- under IMAGE_EMBEDDER_VARIANT=modal-siglip will:
--   - Skip the 21,943 slugs already stamped 'siglip2-...'
--   - Re-claim the ~749 CLIP-only slugs (their stamp is the CLIP tag)
--   - Embed them under SigLIP (the new row coexists; PK includes
--     model_version)
--   - Update the stamp to 'siglip2-...'
-- — closing the SigLIP `crop_type=full` gap to 100% coverage.
--
-- The art-crop cron (embed-card-art-crops) doesn't read
-- canonical_cards bookkeeping; it dedupes via card_image_embeddings
-- source_hash, which already includes model_version. That cron just
-- needs the embedder swap (separate code change in the cron file).
--
-- Idempotent: the column add and the backfill both no-op if already
-- applied.

alter table public.canonical_cards
  add column if not exists image_embedded_model_version text null;

comment on column public.canonical_cards.image_embedded_model_version is
  'model_version tag of the embedding currently in card_image_embeddings '
  'for this slug at (variant_index=0, crop_type=''full''). Used by the '
  'refresh-card-image-embeddings cron as the model-aware claim filter '
  '— rows whose stamp differs from the active embedder''s modelVersion '
  'are re-claimed and re-embedded. NULL = never embedded.';

-- No new index. The cron paginates via the existing
-- `canonical_cards_image_embed_todo_idx` (slug-ordered, partial on
-- `mirrored_primary_image_url IS NOT NULL AND image_embed_attempts < 5`,
-- added in 20260419185606_canonical_cards_image_embed_tracking.sql).
-- That index drives the keyset scan; the new model_version filter is
-- evaluated as an inexpensive post-filter on the already-narrowed
-- candidate set. A separate index on image_embedded_model_version
-- would be dead weight in steady state — once the catalog is
-- backfilled, ~all rows carry the active variant's stamp, so any
-- partial index on "stamp present" or "stamp != active" covers the
-- whole table.

-- Backfill: for every canonical_cards row that has been stamped
-- (image_embedded_at is not null), determine which model_version is
-- actually present in card_image_embeddings at the primary slot
-- (variant_index=0, crop_type='full') and set the new column to that
-- value. If multiple rows exist (shouldn't, but defensive), pick the
-- most recently updated one — that's the latest write to the slot.
--
-- Slugs with image_embedded_at set but NO row in card_image_embeddings
-- (data drift, partial migration, etc.) get NULL — the cron will
-- re-claim them on the next pass, which is the correct behavior.
update public.canonical_cards cc
set image_embedded_model_version = sub.model_version
from (
  select distinct on (canonical_slug)
    canonical_slug,
    model_version
  from public.card_image_embeddings
  where variant_index = 0
    and crop_type = 'full'
  order by canonical_slug, updated_at desc
) sub
where sub.canonical_slug = cc.slug
  and cc.image_embedded_model_version is null
  and cc.image_embedded_at is not null;
