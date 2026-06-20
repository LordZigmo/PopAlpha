-- 20260620140000_crosslink_mega_charizard_x_ex.sql
--
-- Manual EN<->JP crosslink for the base-holo Mega Charizard X ex so the
-- CardDetailView language toggle works on this iconic card.
--
-- Why manual: the automated matcher (scripts/backfill-card-translations.mjs ->
-- findPairBySetCodeInCatalog) pairs by set-code + card name within a verified
-- set pair. The EN "Phantasmal Flames" (me2) and JP "Inferno X" (m2) ARE the
-- same expansion, but each holds FOUR cards named exactly "Mega Charizard X ex"
-- (base + SAR/SIR/UR variants), so the name match is AMBIGUOUS and the matcher
-- writes nothing for any of them. The card_translations design anticipates
-- exactly this: multi-version chase cards are paired by hand with
-- source='manual', which deletePairingsForEnSlug / upsertPrimaryPairing
-- deliberately never delete or overwrite (they only touch source='set_pair'),
-- so this row survives the weekly refresh-card-translations cron.
--
-- This pairs ONLY the base holo (#13 in both — same expansion, same number,
-- top image-embedding cosine 0.8788, both named "Mega Charizard X ex"), which
-- is the canonical/iconic representation. The SAR/SIR/UR and promo variants
-- (EN me2 109/125/130 + promos, JP 94/110/116 + m2a-223) are intentionally NOT
-- paired here: EN and JP assign divergent numbers to those rarity tiers and
-- cosine collapses across the shared artwork, so they need per-art manual
-- verification rather than a guess.
--
-- Idempotent: ON CONFLICT updates provenance. Guarded on both slugs existing
-- with the expected language so a renamed/removed slug makes this a no-op
-- instead of a failed apply (the FK to canonical_cards would otherwise abort).

insert into public.card_translations (en_slug, jp_slug, confidence, source, rank)
select
  'phantasmal-flames-13-mega-charizard-x-ex',
  'inferno-x-13-mega-charizard-x-ex-jp',
  1.0,
  'manual',
  0
where exists (
    select 1 from public.canonical_cards
    where slug = 'phantasmal-flames-13-mega-charizard-x-ex' and language = 'EN'
  )
  and exists (
    select 1 from public.canonical_cards
    where slug = 'inferno-x-13-mega-charizard-x-ex-jp' and language = 'JP'
  )
on conflict (en_slug, jp_slug) do update
  set confidence = excluded.confidence,
      source = excluded.source,
      rank = excluded.rank,
      updated_at = now();
