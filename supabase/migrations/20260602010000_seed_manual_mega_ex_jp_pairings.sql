-- Manual EN<->JP card_translations for the Ascended Heroes <-> MEGA Dream ex
-- "Mega ex" chase cards (SAR ladders).
--
-- Why these are manual (the rule matcher can't produce them)
-- ----------------------------------------------------------
-- refresh-card-translations pairs cards by NAME within a verified set pair. The
-- "Mega <Pokemon> ex" cards have multiple same-name versions per side (e.g. Mega
-- Dragonite ex: 4 EN + 4 JP), so every name match is "ambiguous" and the rule
-- writes nothing. (There's also no Ascended Heroes <-> MEGA Dream ex row in
-- set_pair_map.) These are paired here by matching RARITY TIER, which is the
-- reliable signal the name lacks:
--   EN "Double Rare"               <-> JP "ダブルレア"
--   EN "MEGA_ATTACK_RARE"          <-> JP "Mega Attack Rare"
--   EN "Special Illustration Rare" <-> JP "スペシャルアートレア"
--   EN "Mega Hyper Rare"           <-> JP "超ウルトラレア"
-- Validated against the user-confirmed TCGplayer pair EN #271 <-> JP #232.
--
-- Durability: written with source='manual'. As of the same PR,
-- lib/jp/translation-match.mjs deletePairingsForEnSlug / upsertPrimaryPairing only
-- delete source='set_pair' rows, so the weekly cron never wipes these. Idempotent.
--
-- Mega Gengar ex's EN Double Rare (#125) has no JP Double Rare in MEGA Dream ex,
-- so it correctly stays unpaired (the rarity join produces no row for it).

-- 1) Rarity-tier matched pairs (everything except the one with a null JP rarity).
with norm as (
  select cc.slug, cc.canonical_name, cc.language,
    case
      when cp.rarity in ('Double Rare', 'ダブルレア') then 'DR'
      when cp.rarity in ('MEGA_ATTACK_RARE', 'Mega Attack Rare') then 'MAR'
      when cp.rarity in ('Special Illustration Rare', 'スペシャルアートレア') then 'SIR'
      when cp.rarity in ('Mega Hyper Rare', '超ウルトラレア') then 'HYPER'
      else null
    end as tier
  from public.canonical_cards cc
  join public.card_printings cp on cp.canonical_slug = cc.slug
  where cc.canonical_name in (
      'Mega Dragonite ex', 'Mega Eelektross ex', 'Mega Hawlucha ex',
      'Mega Scrafty ex', 'Mega Diancie ex', 'Mega Gengar ex'
    )
    and (
      (cc.slug like 'ascended-heroes-%' and cc.language = 'EN')
      or (cc.slug like 'mega-dream-ex-%-jp' and cc.language = 'JP')
    )
),
dn as (select distinct canonical_name, language, slug, tier from norm where tier is not null),
pairs as (
  select en.slug as en_slug, jp.slug as jp_slug
  from dn en
  join dn jp on jp.canonical_name = en.canonical_name and jp.tier = en.tier and jp.language = 'JP'
  where en.language = 'EN'
)
insert into public.card_translations (en_slug, jp_slug, confidence, source, rank, created_at, updated_at)
select en_slug, jp_slug, 1.0, 'manual', 0, now(), now() from pairs
on conflict (en_slug, jp_slug) do update
  set source = 'manual', confidence = 1.0, rank = 0, updated_at = now();

-- 2) Mega Dragonite ex Mega-Attack-Rare: JP #232 has a null rarity in our catalog,
--    so the rarity join can't catch it. Pair explicitly (user-verified). Guarded
--    on existence so this is safe on environments missing either card.
insert into public.card_translations (en_slug, jp_slug, confidence, source, rank, created_at, updated_at)
select 'ascended-heroes-271-mega-dragonite-ex', 'mega-dream-ex-232-mega-dragonite-ex-jp', 1.0, 'manual', 0, now(), now()
where exists (select 1 from public.canonical_cards where slug = 'ascended-heroes-271-mega-dragonite-ex')
  and exists (select 1 from public.canonical_cards where slug = 'mega-dream-ex-232-mega-dragonite-ex-jp')
on conflict (en_slug, jp_slug) do update
  set source = 'manual', confidence = 1.0, rank = 0, updated_at = now();
