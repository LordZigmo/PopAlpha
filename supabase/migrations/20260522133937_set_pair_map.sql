-- 20260522133937_set_pair_map.sql
--
-- Cross-language set-pair lookup table.
--
-- Scrydex assigns set IDs per-language (e.g. EN `base1` = Base Set,
-- JP `base1_ja` = 拡張パック / Expansion Pack). For most paired sets
-- the `<id>` ↔ `<id>_ja` convention holds, but it BREAKS where EN/JP
-- release cadence diverged — most famously `base4` (EN = Base Set 2)
-- vs `base4_ja` (JP = Rocket Gang). EN inserted Base Set 2 in 2000
-- with no JP counterpart, offsetting every later numeric pair.
--
-- This table is the authoritative mapping. Each row records a single
-- EN-set ↔ JP-set equivalence with provenance and an auto-measured
-- content-overlap percentage so we can distinguish high-confidence
-- pairs from coincidental ID collisions.
--
-- Populated by:
--   scripts/build-set-pair-map.mjs — scans every EN set_code, looks
--   for a JP set whose name-match overlap exceeds AUTO_VERIFY_PCT
--   (default 0.50), marks verified=true and source='auto'. Re-runnable.
--
-- Operators can hand-add rows with source='manual' to bridge cases
-- the auto scan misses (Base Set 2 → Base Set, Celebrations Classic
-- Collection → Base Set, modern bundled-from-multi-JP-set cases).
--
-- Consumed by:
--   lib/jp/translation-match.mjs findPairBySetPair() — joins via
--   card_printings.set_code on both sides + canonical_name equality
--   to pick the JP pair for a given EN canonical_slug.

create table if not exists public.set_pair_map (
  en_set_code      text        primary key,
  jp_set_code      text        not null,
  -- Display labels captured at build time for ops review; never used
  -- in the picker SQL. Kept here so an operator scanning this table
  -- doesn't have to JOIN through card_printings to know what set the
  -- code refers to.
  en_set_name      text,
  jp_set_name      text,
  -- name_match_pct = name_match_count / en_set_card_count, where
  -- name_match_count is the number of EN cards in this set whose
  -- canonical_name (case-insensitive) appears as a canonical_name
  -- on at least one JP card in the candidate JP set. Computed once
  -- by the build script; not maintained continuously.
  name_match_pct   real        check (name_match_pct is null or (name_match_pct >= 0 and name_match_pct <= 1)),
  en_card_count    integer,
  jp_card_count    integer,
  name_match_count integer,
  verified         boolean     not null default false,
  source           text        not null default 'auto'
                               check (source in ('auto', 'manual')),
  override_reason  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Reverse lookup (JP -> EN) for the symmetric case in the picker.
-- A given JP set can in theory map to >1 EN set (e.g. modern JP sets
-- bundled into a bigger EN set), so the index is non-unique.
create index if not exists set_pair_map_jp_idx
  on public.set_pair_map (jp_set_code);

-- RLS: anon + authenticated can SELECT (this is catalog metadata,
-- same trust tier as canonical_cards). Writes happen via service-role
-- only (the build script + the cron's no-op refresh).
alter table public.set_pair_map enable row level security;
revoke all on table public.set_pair_map from anon, authenticated;
grant select on table public.set_pair_map to anon, authenticated;

drop policy if exists set_pair_map_read_all on public.set_pair_map;
create policy set_pair_map_read_all
  on public.set_pair_map
  for select
  to anon, authenticated
  using (true);

comment on table public.set_pair_map is
  'EN ↔ JP Scrydex set_code pairings used by the EN/JP card-translation matcher. The `<en>_ja` convention is a candidate, not a guarantee — name_match_pct documents the auto-measured overlap and `verified` gates whether the picker trusts the pair. Operators can hand-add rows with source=manual for reprint / bundled-set cases the auto scan misses.';

comment on column public.set_pair_map.name_match_pct is
  'Fraction of EN cards in this set whose canonical_name also appears on a JP card in the paired JP set. Auto-computed by scripts/build-set-pair-map.mjs. NULL for manual rows where overlap wasn''t measured.';

comment on column public.set_pair_map.verified is
  'True when this pair is safe to use in card_translations. Auto pairs require name_match_pct >= 0.50; manual pairs are auto-verified.';

comment on column public.set_pair_map.source is
  'How this row was created: auto (overlap-scan script) or manual (operator override, e.g. EN Base Set 2 → JP base1 because EN reprinted the 1996 JP art).';
