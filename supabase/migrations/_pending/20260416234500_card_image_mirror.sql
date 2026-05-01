-- 20260416234500_card_image_mirror.sql
--
-- Mirror Scrydex card images into our own Supabase Storage so iOS and web
-- clients stop hot-pathing the Scrydex CDN.
--
-- Approach: add nullable "mirrored_*" columns to canonical_cards and
-- card_printings alongside existing URL columns, plus a backlog-indexing
-- column (image_mirrored_at) and an attempt counter. A cron worker fills
-- these over time; read paths use a resolver that prefers mirrored URLs
-- and falls back to the original Scrydex URL.
--
-- No existing URL column is modified — this is purely additive so we can
-- roll back by dropping the new columns and the bucket without data loss.

-- ── card_printings ─────────────────────────────────────────────────────────
alter table public.card_printings
  add column if not exists mirrored_image_url      text        null,
  add column if not exists mirrored_thumb_url      text        null,
  add column if not exists image_mirrored_at       timestamptz null,
  add column if not exists image_mirror_attempts   smallint    not null default 0,
  add column if not exists image_mirror_last_error text        null;

-- Partial index that powers the cron worker's claim query. Only rows that
-- (a) have a source URL to mirror, (b) haven't been mirrored yet, and
-- (c) haven't burned through the retry budget qualify.
create index if not exists card_printings_mirror_todo_idx
  on public.card_printings (id)
  where image_url is not null
    and image_mirrored_at is null
    and image_mirror_attempts < 5;

-- ── canonical_cards ────────────────────────────────────────────────────────
alter table public.canonical_cards
  add column if not exists mirrored_primary_image_url   text        null,
  add column if not exists mirrored_primary_thumb_url   text        null,
  add column if not exists image_mirrored_at            timestamptz null,
  add column if not exists image_mirror_attempts        smallint    not null default 0,
  add column if not exists image_mirror_last_error      text        null;

create index if not exists canonical_cards_mirror_todo_idx
  on public.canonical_cards (slug)
  where primary_image_url is not null
    and image_mirrored_at is null
    and image_mirror_attempts < 5;

-- ── Storage bucket ─────────────────────────────────────────────────────────
-- Public read; writes restricted to service role (default behavior — no
-- RLS policy needed because service role bypasses RLS).
insert into storage.buckets (id, name, public)
values ('card-images', 'card-images', true)
on conflict (id) do nothing;
