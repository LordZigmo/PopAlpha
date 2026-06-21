-- 20260620160000_crosslink_cleffa_obsidian_flames.sql
--
-- Manual EN<->JP crosslink for the Illustration/Art-Rare Cleffa so the
-- CardDetailView language toggle works on it:
--   EN  obsidian-flames-202-cleffa            (Obsidian Flames #202)
--   JP  ruler-of-the-black-flame-113-cleffa-jp (Ruler of the Black Flame #113)
--
-- EN "Obsidian Flames" and JP "Ruler of the Black Flame" are the same
-- expansion; #202 / #113 are the special-art Cleffa above each set's base
-- numbering. The automated matcher (findPairBySetCodeInCatalog) pairs by
-- set-code + card name within a verified set pair, and a set holds multiple
-- same-named Cleffa prints (base + AR/IR), so the name match is AMBIGUOUS and
-- it writes nothing. card_translations is designed for hand-pairing these:
-- source='manual' rows are never deleted/overwritten by the weekly refresh
-- cron (it only touches source='set_pair'), so the override is durable.
--
-- Idempotent (ON CONFLICT updates provenance) and guarded on both slugs
-- existing with the expected language, so a renamed/removed slug makes this a
-- no-op instead of a failed apply. Same pattern as
-- 20260620140000_crosslink_mega_charizard_x_ex.sql.

insert into public.card_translations (en_slug, jp_slug, confidence, source, rank)
select
  'obsidian-flames-202-cleffa',
  'ruler-of-the-black-flame-113-cleffa-jp',
  1.0,
  'manual',
  0
where exists (
    select 1 from public.canonical_cards
    where slug = 'obsidian-flames-202-cleffa' and language = 'EN'
  )
  and exists (
    select 1 from public.canonical_cards
    where slug = 'ruler-of-the-black-flame-113-cleffa-jp' and language = 'JP'
  )
on conflict (en_slug, jp_slug) do update
  set confidence = excluded.confidence,
      source = excluded.source,
      rank = excluded.rank,
      updated_at = now();
