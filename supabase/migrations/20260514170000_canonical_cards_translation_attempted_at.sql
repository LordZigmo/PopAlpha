-- 20260514170000_canonical_cards_translation_attempted_at.sql
--
-- Adds the per-row "last time we tried to find a JP pairing" stamp
-- that lets the refresh-card-translations cron advance through the
-- catalog without stalling on unpairable leading slugs.
--
-- Background: the cron's candidate set is `NOT EXISTS
-- card_translations WHERE rank=0` — slugs that successfully pair
-- exit the set, but slugs whose top kNN candidate fails the cosine
-- bar (or has no qualifying JP candidate at all) stay in forever.
-- Combined with `ORDER BY slug ASC LIMIT 400`, that means once the
-- alphabetically-first 400 EN slugs are unpairable, every weekly
-- run re-processes the same 400 and never reaches later slugs.
-- Codex P2 on PR #67 flagged this explicitly.
--
-- Fix: stamp `translation_attempted_at` after each attempt (whether
-- it pairs or not), order by this column ASC NULLS FIRST so
-- never-tried slugs come first, and filter out anything tried
-- within the last 14 days. Unpairable slugs cycle back every 14
-- days so the cron picks them up again after JP catalog growth.
--
-- Mirrors the `image_embed_attempts` / `image_embedded_at` pattern
-- already in place for the embedding refresh cron, but timestamp-
-- only (no counter) because retries should resume as the JP
-- catalog grows, not give up after N tries.

alter table public.canonical_cards
  add column if not exists translation_attempted_at timestamptz null;

comment on column public.canonical_cards.translation_attempted_at is
  'Last time the refresh-card-translations cron / backfill script tried to find a JP pairing for this EN slug. Stamped after every attempt regardless of outcome. The cron uses (attempted_at IS NULL OR attempted_at < now() - interval ''14 days'') to retry unpairable slugs roughly every fortnight, picking up newly-imported JP catalog rows over time.';

-- Partial index: only EN rows ever participate in the candidate
-- set. Keeps the index small (~150k rows instead of ~400k) and
-- supports the cron's primary `ORDER BY translation_attempted_at`.
create index if not exists canonical_cards_translation_attempted_idx
  on public.canonical_cards (translation_attempted_at asc nulls first, slug asc)
  where language = 'EN';
