-- Crosslink the EN "Perfect Order" (me3) <-> JP "Nihil Zero" (m3_ja) expansion.
--
-- These are the same set, but NONE of their cards were crosslinked because
-- set_pair_map had no me3<->m3_ja row, and the card matcher
-- (findPairBySetCodeInCatalog) only pairs cards WITHIN a verified set pair —
-- so the whole expansion (e.g. Antique Jaw Fossil) had a dead EN<->JP toggle.
--
-- Two parts:
--
-- 1) Register the set pair (root cause). Manual + verified, so the card matcher
--    crosslinks this set on every future run AND new imports. build-set-pair-map
--    SKIPS source='manual' rows, so this override is durable. Note: EN/JP
--    numbering does NOT align for this set (only ~25 share a card_number), so
--    the matcher's name-based pairing — not number — is the right signal.
--
-- 2) Seed card_translations for the 55 UNAMBIGUOUS pairs now (don't wait for the
--    weekly cron): cards whose canonical_name is unique on BOTH sides, so the
--    pairing is certain regardless of the divergent numbering. Written
--    source='manual' (durable; deletePairingsForEnSlug/upsertPrimaryPairing only
--    touch source='set_pair', and the cron will re-affirm these as set_pair on
--    its next pass via the now-present set_pair_map row). Idempotent.
--
-- NOT covered here: repeated-name cards (the same Pokemon at multiple rarities —
-- ex / SAR / SIR ladders). Their name is ambiguous and their numbers diverge,
-- so they need rarity-tier hand-pairing in a follow-up (the pattern in
-- 20260602010000_seed_manual_mega_ex_jp_pairings.sql), not a name guess.

-- 1) Set-pair registration.
insert into public.set_pair_map (
  en_set_code, jp_set_code, en_set_name, jp_set_name,
  en_card_count, jp_card_count, name_match_count,
  verified, source, override_reason
)
values (
  'me3', 'm3_ja', 'Perfect Order', 'Nihil Zero',
  124, 117, 55,
  true, 'manual',
  'Same expansion (EN Perfect Order / JP Nihil Zero); auto-builder missed the pair so the whole set had no EN<->JP crosslinks. Verified by shared card names; EN/JP numbering diverges so pairing is name-based.'
)
on conflict (en_set_code) do update
  set jp_set_code = excluded.jp_set_code,
      en_set_name = excluded.en_set_name,
      jp_set_name = excluded.jp_set_name,
      verified = true,
      source = 'manual',
      override_reason = excluded.override_reason,
      updated_at = now();

-- 2) Seed the unambiguous (unique-name-on-both-sides) card pairs.
with en as (
  select canonical_name, slug
  from public.canonical_cards
  where set_name = 'Perfect Order' and language = 'EN'
),
jp as (
  select canonical_name, slug
  from public.canonical_cards
  where set_name = 'Nihil Zero' and language = 'JP'
),
en_unique as (
  select canonical_name, max(slug) as slug
  from en group by canonical_name having count(*) = 1
),
jp_unique as (
  select canonical_name, max(slug) as slug
  from jp group by canonical_name having count(*) = 1
),
pairs as (
  select e.slug as en_slug, j.slug as jp_slug
  from en_unique e
  join jp_unique j on j.canonical_name = e.canonical_name
)
insert into public.card_translations (en_slug, jp_slug, confidence, source, rank, created_at, updated_at)
select en_slug, jp_slug, 1.0, 'manual', 0, now(), now() from pairs
on conflict (en_slug, jp_slug) do update
  set source = 'manual', confidence = 1.0, rank = 0, updated_at = now();
