-- Tier-1 EN<->JP set-pair backfill: register 14 same-expansion set pairs that
-- were missing from set_pair_map, then seed card_translations for every
-- unambiguous (unique-name-on-both-sides) card in each.
--
-- Audit (2026-06-20): of 217 EN set-codes only 18 were registered; the matcher
-- only crosslinks cards WITHIN a verified set_pair_map row, so these whole
-- expansions had dead EN<->JP toggles. These 14 are the high-confidence pairs
-- (>=70% containment of the smaller set + matching set-code family + verified
-- name): special/shiny sets and the Mega era. NOT included: SV/SwSh BASE sets
-- that split into TWO JP half-sets (e.g. Temporal Forces = Wild Force + Cyber
-- Judge) — set_pair_map is 1:1, so those need a separate two-set design.
--
-- Supersedes the standalone Perfect Order PR (#296): me3<->m3_ja is folded in
-- here (idempotent).
--
-- Durability: set_pair_map rows are source='manual' (build-set-pair-map SKIPS
-- those), and card_translations rows are source='manual' (the weekly cron's
-- deletePairingsForEnSlug/upsertPrimaryPairing only touch source='set_pair').
-- Both idempotent. EN/JP numbering often diverges across these, so pairing is
-- NAME-based (the matcher's signal), restricted to names unique on both sides.
-- Repeated-name rarity ladders (ex/SAR/SIR) are intentionally left for
-- rarity-tier hand-pairing (the 20260602010000 pattern).

-- 1) Register the set pairs.
insert into public.set_pair_map (en_set_code, jp_set_code, en_set_name, jp_set_name, verified, source, override_reason)
values
  ('sv3pt5',      'sv2a_ja',   '151',                          'Pokémon Card 151',      true, 'manual', 'Tier-1 audit backfill: same expansion, auto-builder missed it.'),
  ('swsh45sv',    'swsh4a_ja', 'Shining Fates Shiny Vault',    'Shiny Star V',          true, 'manual', 'Tier-1 audit backfill.'),
  ('swsh12pt5gg', 'swsh12a_ja','Crown Zenith Galarian Gallery','VSTAR Universe',        true, 'manual', 'Tier-1 audit backfill.'),
  ('sma',         'sm8b_ja',   'Hidden Fates Shiny Vault',     'GX Ultra Shiny',        true, 'manual', 'Tier-1 audit backfill.'),
  ('me1',         'm1s_ja',    'Mega Evolution',               'Mega Symphonia',        true, 'manual', 'Tier-1 audit backfill.'),
  ('me2',         'm2_ja',     'Phantasmal Flames',            'Inferno X',             true, 'manual', 'Tier-1 audit backfill (the Mega Charizard X ex set).'),
  ('me3',         'm3_ja',     'Perfect Order',                'Nihil Zero',            true, 'manual', 'Tier-1 audit backfill (folds in #296).'),
  ('me4',         'm4_ja',     'Chaos Rising',                 'Ninja Spinner',         true, 'manual', 'Tier-1 audit backfill.'),
  ('rsv10pt5',    'sv11w_ja',  'White Flare',                  'White Flare',           true, 'manual', 'Tier-1 audit backfill (same set name).'),
  ('zsv10pt5',    'sv11b_ja',  'Black Bolt',                   'Black Bolt',            true, 'manual', 'Tier-1 audit backfill (same set name).'),
  ('sv6pt5',      'sv6a_ja',   'Shrouded Fable',               'Night Wanderer',        true, 'manual', 'Tier-1 audit backfill.'),
  ('sv4pt5',      'sv4a_ja',   'Paldean Fates',                'Shiny Treasure ex',     true, 'manual', 'Tier-1 audit backfill.'),
  ('sv8pt5',      'sv8a_ja',   'Prismatic Evolutions',         'Terastal Festival ex',  true, 'manual', 'Tier-1 audit backfill.'),
  ('me2pt5',      'm2a_ja',    'Ascended Heroes',              'MEGA Dream ex',         true, 'manual', 'Tier-1 audit backfill (set pair; card-level Mega-ex pairings already in 20260602010000).')
on conflict (en_set_code) do update
  set jp_set_code = excluded.jp_set_code,
      en_set_name = excluded.en_set_name,
      jp_set_name = excluded.jp_set_name,
      verified = true,
      source = 'manual',
      override_reason = excluded.override_reason,
      updated_at = now();

-- 2) Seed card_translations within each registered pair. Two SAFE signals,
--    unioned (verified 0 conflicts — no EN card maps to two JP cards):
--      A) name + card_number both match, unique on each side — disambiguates
--         repeated names (shiny sets) when EN/JP numbering aligns.
--      B) canonical_name unique on each side — catches the rest regardless of
--         number (numbering often diverges across these expansions).
--    Repeated-name cards whose numbers ALSO diverge (e.g. the SAR/SIR ladders)
--    match neither and stay for rarity-tier hand-pairing.
with pairs as (
  select en_set_code, jp_set_code from public.set_pair_map
  where en_set_code in (
    'sv3pt5','swsh45sv','swsh12pt5gg','sma','me1','me2','me3','me4',
    'rsv10pt5','zsv10pt5','sv6pt5','sv4pt5','sv8pt5','me2pt5'
  )
),
en as (
  select split_part(split_part(primary_image_url,'/pokemon/',2),'-',1) as set_code,
         canonical_name, card_number, slug
  from public.canonical_cards
  where language = 'EN' and primary_image_url is not null
),
jp as (
  select split_part(split_part(primary_image_url,'/pokemon/',2),'-',1) as set_code,
         canonical_name, card_number, slug
  from public.canonical_cards
  where language = 'JP' and primary_image_url is not null
),
en_in as (
  select p.en_set_code, p.jp_set_code, e.canonical_name, e.card_number, e.slug
  from en e join pairs p on p.en_set_code = e.set_code
),
jp_in as (
  select p.en_set_code, p.jp_set_code, j.canonical_name, j.card_number, j.slug
  from jp j join pairs p on p.jp_set_code = j.set_code
),
-- A) name + number, unique on each side
en_nn as (
  select en_set_code, jp_set_code, canonical_name, card_number, max(slug) as slug
  from en_in group by en_set_code, jp_set_code, canonical_name, card_number having count(*) = 1
),
jp_nn as (
  select en_set_code, jp_set_code, canonical_name, card_number, max(slug) as slug
  from jp_in group by en_set_code, jp_set_code, canonical_name, card_number having count(*) = 1
),
matched_nn as (
  select e.slug as en_slug, j.slug as jp_slug
  from en_nn e
  join jp_nn j
    on j.en_set_code = e.en_set_code and j.jp_set_code = e.jp_set_code
   and j.canonical_name = e.canonical_name and j.card_number = e.card_number
),
-- B) name unique on each side
en_nu as (
  select en_set_code, jp_set_code, canonical_name, max(slug) as slug
  from en_in group by en_set_code, jp_set_code, canonical_name having count(*) = 1
),
jp_nu as (
  select en_set_code, jp_set_code, canonical_name, max(slug) as slug
  from jp_in group by en_set_code, jp_set_code, canonical_name having count(*) = 1
),
matched_nu as (
  select e.slug as en_slug, j.slug as jp_slug
  from en_nu e
  join jp_nu j
    on j.en_set_code = e.en_set_code and j.jp_set_code = e.jp_set_code
   and j.canonical_name = e.canonical_name
),
matched as (
  select en_slug, jp_slug from matched_nn
  union
  select en_slug, jp_slug from matched_nu
)
insert into public.card_translations (en_slug, jp_slug, confidence, source, rank, created_at, updated_at)
select en_slug, jp_slug, 1.0, 'manual', 0, now(), now() from matched
on conflict (en_slug, jp_slug) do update
  set source = 'manual', confidence = 1.0, rank = 0, updated_at = now();
