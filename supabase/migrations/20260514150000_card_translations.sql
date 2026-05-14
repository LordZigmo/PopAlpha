-- 20260514150000_card_translations.sql
--
-- Cross-language card pairing (EN <-> JP) for the CardDetailView toggle.
--
-- Today canonical_cards holds EN and JP versions of "the same card" as
-- entirely separate rows with no relationship between them — the
-- `language` column is a filter dimension, not a join key. That makes
-- it impossible to surface a JP equivalent of an EN card (or vice
-- versa) without an explicit mapping.
--
-- This migration ships the pairing storage layer only. The matching
-- pipeline (scripts/backfill-card-translations.mjs + the
-- refresh-card-translations cron) lives outside the migration and
-- populates this table from SigLIP image-embedding cosine similarity
-- with a JP name-glossary precision gate.
--
-- Schema choice: junction table over a `paired_slug` column on
-- canonical_cards. Reasons:
--   1. 1:N realities — one EN print can have a JP booster + a JP
--      promo equivalent. A scalar column forces lossy "best-effort"
--      picks at write time and discards alternatives.
--   2. confidence + source are first-class metadata; a scalar would
--      grow `paired_slug_confidence` and `paired_slug_source` siblings
--      we'd then need to keep in lockstep.
--   3. Symmetry — EN→JP and JP→EN both read the same row via two
--      indexes.
--   4. Idempotent backfill — primary key on (en_slug, jp_slug) makes
--      re-runs ON CONFLICT DO UPDATE safe.
--
-- The rank column lets the backfill record runner-up pairings (rank 1, 2)
-- alongside the primary (rank 0). Readers should filter rank=0 unless
-- they specifically want alternates.

create table if not exists public.card_translations (
  en_slug    text        not null
                         references public.canonical_cards(slug) on delete cascade,
  jp_slug    text        not null
                         references public.canonical_cards(slug) on delete cascade,
  confidence real        not null check (confidence between 0 and 1),
  source     text        not null,
  rank       smallint    not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (en_slug, jp_slug)
);

-- EN -> JP lookup: "given this EN card, what's its primary JP pairing?"
-- Filtered by rank for hot-path reads at rank=0.
create index if not exists card_translations_en_idx
  on public.card_translations (en_slug, rank, confidence desc);

-- JP -> EN lookup: the same row indexed from the other side.
create index if not exists card_translations_jp_idx
  on public.card_translations (jp_slug, rank, confidence desc);

-- RLS: anon + authenticated readers can SELECT (pairings are public
-- catalog data — same trust tier as canonical_cards.language). All
-- writes happen via service-role (backfill script + cron).
alter table public.card_translations enable row level security;
revoke all on table public.card_translations from anon, authenticated;
grant select on table public.card_translations to anon, authenticated;

drop policy if exists card_translations_read_all on public.card_translations;
create policy card_translations_read_all
  on public.card_translations
  for select
  to anon, authenticated
  using (true);

comment on table public.card_translations is
  'EN <-> JP cross-language pairings for the same Pokemon card. Junction over canonical_cards.slug. Populated by scripts/backfill-card-translations.mjs via SigLIP image-embedding cosine + JP name glossary gating; refreshed weekly by /api/cron/refresh-card-translations to absorb new JP catalog imports.';

comment on column public.card_translations.confidence is
  '[0,1] match confidence. Sourced from cosine similarity for image_embedding_v1 rows. rank=0 backfill threshold is 0.90; rank>=1 alternates land at 0.85.';

comment on column public.card_translations.source is
  'How the pairing was established: image_embedding_v1 (cosine + glossary gate), manual (admin override), set_card_number (future signal).';

comment on column public.card_translations.rank is
  '0 = primary pairing surfaced to readers. Higher ranks are alternates kept for diagnostics / future review tooling.';
