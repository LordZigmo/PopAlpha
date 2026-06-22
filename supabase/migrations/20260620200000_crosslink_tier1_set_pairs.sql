-- Tier-1 EN<->JP set-pair backfill: register 13 same-expansion set pairs that
-- were missing from set_pair_map, then seed card_translations for every
-- unambiguous card in each.
--
-- Audit (2026-06-20): of 217 EN set-codes only 18 were registered; the matcher
-- only crosslinks cards WITHIN a verified set_pair_map row, so these whole
-- expansions had dead EN<->JP toggles. These 13 are 1:1 pairs verified by
-- top-2-JP-overlap analysis (a single dominant JP counterpart; second matches
-- are vintage same-name coincidence or promos).
--
-- EXCLUDED — 1:2 split sets (need a separate one-EN-to-two-JP design, NOT a
-- 1:1 set_pair_map row keyed on en_set_code):
--   * me1 Mega Evolution = JP Mega Brave (m1l_ja) + Mega Symphonia (m1s_ja) —
--     both ~95% contained; mapping me1 to only one half leaves the other dead
--     and blocks adding it later.
--   * SV/SwSh base sets (Temporal Forces, Paradox Rift, Battle Styles, ...).
-- Also excluded: repeated-name rarity ladders (ex/SAR/SIR) whose names AND
-- numbers diverge — rarity-tier hand-pairing (the 20260602010000 pattern).
--
-- Supersedes the standalone Perfect Order PR (#296): me3<->m3_ja is folded in.
--
-- Card-pair source by type (durability — see translation-match.mjs):
--   * UNIQUE-name pairs -> source='set_pair'. The weekly cron re-derives these
--     (name-match within the now-verified set pair) and OWNS them; seeding them
--     manual would just be flipped to set_pair on the next pass anyway.
--   * repeated-name pairs matched by name+card_number -> source='manual'. The
--     cron's name-only matcher sees these as AMBIGUOUS and never upserts them;
--     deletePairingsForEnSlug only deletes source='set_pair', so 'manual' keeps
--     them durable (and uncloberrable). Verified 0 conflicts (no EN card maps
--     to two JP cards).

-- 1) Register the set pairs.
insert into public.set_pair_map (en_set_code, jp_set_code, en_set_name, jp_set_name, verified, source, override_reason)
values
  ('sv3pt5',      'sv2a_ja',   '151',                          'Pokémon Card 151',      true, 'manual', 'Tier-1 audit backfill: same expansion, auto-builder missed it.'),
  ('swsh45sv',    'swsh4a_ja', 'Shining Fates Shiny Vault',    'Shiny Star V',          true, 'manual', 'Tier-1 audit backfill.'),
  ('swsh12pt5gg', 'swsh12a_ja','Crown Zenith Galarian Gallery','VSTAR Universe',        true, 'manual', 'Tier-1 audit backfill.'),
  ('sma',         'sm8b_ja',   'Hidden Fates Shiny Vault',     'GX Ultra Shiny',        true, 'manual', 'Tier-1 audit backfill.'),
  ('me2',         'm2_ja',     'Phantasmal Flames',            'Inferno X',             true, 'manual', 'Tier-1 audit backfill (the Mega Charizard X ex set).'),
  ('me3',         'm3_ja',     'Perfect Order',                'Nihil Zero',            true, 'manual', 'Tier-1 audit backfill (folds in #296).'),
  ('me4',         'm4_ja',     'Chaos Rising',                 'Ninja Spinner',         true, 'manual', 'Tier-1 audit backfill.'),
  ('rsv10pt5',    'sv11w_ja',  'White Flare',                  'White Flare',           true, 'manual', 'Tier-1 audit backfill (same set name).'),
  ('zsv10pt5',    'sv11b_ja',  'Black Bolt',                   'Black Bolt',            true, 'manual', 'Tier-1 audit backfill (same set name).'),
  ('sv6pt5',      'sv6a_ja',   'Shrouded Fable',               'Night Wanderer',        true, 'manual', 'Tier-1 audit backfill.'),
  ('sv4pt5',      'sv4a_ja',   'Paldean Fates',                'Shiny Treasure ex',     true, 'manual', 'Tier-1 audit backfill.'),
  ('sv8pt5',      'sv8a_ja',   'Prismatic Evolutions',         'Terastal Festival ex',  true, 'manual', 'Tier-1 audit backfill.'),
  ('me2pt5',      'm2a_ja',    'Ascended Heroes',              'MEGA Dream ex',         true, 'manual', 'Tier-1 audit backfill (card-level Mega-ex pairings already in 20260602010000).')
on conflict (en_set_code) do update
  set jp_set_code = excluded.jp_set_code,
      en_set_name = excluded.en_set_name,
      jp_set_name = excluded.jp_set_name,
      verified = true,
      source = 'manual',
      override_reason = excluded.override_reason,
      updated_at = now();

-- 2) Seed card_translations. Single insert: source is set per row
--    (set_pair for unique-name, manual for repeated-name+number). The
--    conflict-WHERE never lets a set_pair write clobber an existing manual row.
with pairs as (
  select en_set_code, jp_set_code from public.set_pair_map
  where en_set_code in (
    'sv3pt5','swsh45sv','swsh12pt5gg','sma','me2','me3','me4',
    'rsv10pt5','zsv10pt5','sv6pt5','sv4pt5','sv8pt5','me2pt5'
  )
),
en as (
  select split_part(split_part(primary_image_url,'/pokemon/',2),'-',1) as set_code,
         canonical_name, card_number, slug
  from public.canonical_cards where language = 'EN' and primary_image_url is not null
),
jp as (
  select split_part(split_part(primary_image_url,'/pokemon/',2),'-',1) as set_code,
         canonical_name, card_number, slug
  from public.canonical_cards where language = 'JP' and primary_image_url is not null
),
en_in as (select p.en_set_code ec, p.jp_set_code jc, e.canonical_name cn, e.card_number num, e.slug
          from en e join pairs p on p.en_set_code = e.set_code),
jp_in as (select p.en_set_code ec, p.jp_set_code jc, j.canonical_name cn, j.card_number num, j.slug
          from jp j join pairs p on p.jp_set_code = j.set_code),
-- unique name on each side
en_nu as (select ec, jc, cn, max(slug) slug from en_in group by ec, jc, cn having count(*) = 1),
jp_nu as (select ec, jc, cn, max(slug) slug from jp_in group by ec, jc, cn having count(*) = 1),
m_nu as (select e.slug en_slug, j.slug jp_slug
         from en_nu e join jp_nu j on j.ec = e.ec and j.jc = e.jc and j.cn = e.cn),
-- name + number unique on each side
en_nn as (select ec, jc, cn, num, max(slug) slug from en_in group by ec, jc, cn, num having count(*) = 1),
jp_nn as (select ec, jc, cn, num, max(slug) slug from jp_in group by ec, jc, cn, num having count(*) = 1),
m_nn as (select e.slug en_slug, j.slug jp_slug
         from en_nn e join jp_nn j on j.ec = e.ec and j.jc = e.jc and j.cn = e.cn and j.num = e.num),
matched as (
  select
    coalesce(nu.en_slug, nn.en_slug) as en_slug,
    coalesce(nu.jp_slug, nn.jp_slug) as jp_slug,
    (nu.en_slug is not null) as is_unique_name
  from m_nu nu
  full outer join m_nn nn on nn.en_slug = nu.en_slug and nn.jp_slug = nu.jp_slug
)
insert into public.card_translations (en_slug, jp_slug, confidence, source, rank, created_at, updated_at)
select en_slug, jp_slug, 1.0,
       case when is_unique_name then 'set_pair' else 'manual' end,
       0, now(), now()
from matched
on conflict (en_slug, jp_slug) do update
  set source = excluded.source, confidence = 1.0, rank = 0, updated_at = now()
  -- A manual seed always wins; a set_pair seed must NOT overwrite a manual row.
  where excluded.source = 'manual' or card_translations.source is distinct from 'manual';
