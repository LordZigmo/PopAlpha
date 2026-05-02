-- 20260419185302_canonical_cards_image_embed_tracking.sql
--
-- Adds attempts / last-error tracking for the Replicate CLIP image
-- embedding pipeline (see app/api/cron/refresh-card-image-embeddings).
--
-- Problem: without an attempts budget, canonical cards whose mirrored
-- source is unreachable (e.g. a Storage object was never written
-- successfully) would be retried on every cron pass, burning paid
-- Replicate GPU time on known-broken URLs.
--
-- Pattern mirrors the existing image-mirror tracking columns added in
-- 20260416234500_card_image_mirror.sql — same attempts cap (5), same
-- partial-index strategy so the claim query stays O(small).
--
-- Rollback: drop the three columns and the partial index. No existing
-- read path depends on them, so this is purely additive.

alter table public.canonical_cards
  add column if not exists image_embed_attempts   smallint    not null default 0,
  add column if not exists image_embed_last_error text        null,
  add column if not exists image_embedded_at      timestamptz null;

-- Partial index powering the cron claim query. Rows eligible for
-- embedding are those that (a) have a mirrored image to feed the
-- embedder, (b) haven't burned through the attempts budget. Slug order
-- matches the cursor-paginated scan in refresh-card-image-embeddings.
create index if not exists canonical_cards_image_embed_todo_idx
  on public.canonical_cards (slug)
  where mirrored_primary_image_url is not null
    and image_embed_attempts < 5;
