-- Dedupe accent-bug canonical_slugs.
--
-- Background
-- ──────────
-- The slugify() function in lib/admin/scrydex-canonical-import.ts produced
-- broken slugs for cards whose name or set name contained accented Latin
-- letters. The lowercase() + [^a-z0-9]+ → "-" pipeline treated `é`, `è`,
-- etc. as separators because lowercase() does NOT decompose them. So
-- "Pokémon GO 27 Pikachu" became "pok-mon-go-27-pikachu" instead of
-- "pokemon-go-27-pikachu".
--
-- The Scrydex API returns the same logical card with both Unicode forms
-- (composed `é` and decomposed `e + ́`) across different fields, so the
-- bug created 216 distinct duplicate-pair canonical_cards rows where the
-- "loser" was the accent-bug version and the "winner" was the clean
-- version. An additional 9 rows surfaced after the conservative twin
-- match (7 missed pairs that needed double-substitution matching and
-- 2 true orphans where only the bug version existed).
--
-- Root cause is fixed by the same commit that lands this migration:
-- lib/admin/scrydex-canonical-import.ts now calls stripDiacritics()
-- before lowercase(). Once fixed, future ingest runs cannot reproduce
-- the bug.
--
-- This migration is idempotent: re-running it on a clean DB is a no-op
-- because every operation is gated on the loser slug actually existing.
--
-- Affected tables (Supabase, in order of cleanup):
--   - card_aliases       (UNIQUE on alias, conflict-delete required)
--   - card_page_views    (no slug-based UNIQUE, plain UPDATE safe)
--   - card_printings     (UNIQUE on source+source_id, plain UPDATE safe)
--   - canonical_cards    (DELETE losers; ON DELETE CASCADE handles rest)
--
-- Neon's card_image_embeddings (separate DB via @vercel/postgres) was
-- pre-cleaned via /api/admin/cleanup/dedupe-canonical-slugs-neon and
-- reported zero loser-slug rows — the embedder always wrote under the
-- clean slug, so Neon was incidentally already correct.

BEGIN;

-- ── Working table holding the full plan ──────────────────────────────
-- Kept inside the migration so future replays / fresh DB rebuilds use
-- the exact same pair list. Dropped at the end.
CREATE TEMP TABLE _dedupe_plan(loser_slug text PRIMARY KEY, winner_slug text NOT NULL);

INSERT INTO _dedupe_plan(loser_slug, winner_slug) VALUES
  -- ── Original 216 conservative twin-match pairs ─────────────────────
  ('pok-mon-go-56-aipom', 'pokemon-go-56-aipom'),
  ('pok-mon-go-5-alolan-exeggutor-v', 'pokemon-go-5-alolan-exeggutor-v'),
  ('pok-mon-go-71-alolan-exeggutor-v', 'pokemon-go-71-alolan-exeggutor-v'),
  ('pok-mon-go-42-alolan-raticate', 'pokemon-go-42-alolan-raticate'),
  ('pok-mon-go-41-alolan-rattata', 'pokemon-go-41-alolan-rattata'),
  ('pok-mon-go-57-ambipom', 'pokemon-go-57-ambipom'),
  ('pok-mon-go-7-ariados', 'pokemon-go-7-ariados'),
  ('pok-mon-go-24-articuno', 'pokemon-go-24-articuno'),
  ('pok-mon-tcg-classic-blastoise-9-articuno', 'pokemon-tcg-classic-blastoise-9-articuno'),
  ('pok-mon-tcg-classic-venusaur-34-basic-fighting-energy', 'pokemon-tcg-classic-venusaur-34-basic-fighting-energy'),
  ('pok-mon-tcg-classic-charizard-33-basic-fire-energy', 'pokemon-tcg-classic-charizard-33-basic-fire-energy'),
  ('pok-mon-tcg-classic-venusaur-33-basic-grass-energy', 'pokemon-tcg-classic-venusaur-33-basic-grass-energy'),
  ('pok-mon-tcg-classic-charizard-34-basic-lightning-energy', 'pokemon-tcg-classic-charizard-34-basic-lightning-energy'),
  ('pok-mon-tcg-classic-blastoise-34-basic-psychic-energy', 'pokemon-tcg-classic-blastoise-34-basic-psychic-energy'),
  ('pok-mon-tcg-classic-blastoise-33-basic-water-energy', 'pokemon-tcg-classic-blastoise-33-basic-water-energy'),
  ('pok-mon-go-60-bibarel', 'pokemon-go-60-bibarel'),
  ('pok-mon-go-59-bidoof', 'pokemon-go-59-bidoof'),
  ('pok-mon-tcg-classic-blastoise-18-bill', 'pokemon-tcg-classic-blastoise-18-bill'),
  ('pok-mon-tcg-classic-charizard-18-bill', 'pokemon-tcg-classic-charizard-18-bill'),
  ('pok-mon-tcg-classic-venusaur-18-bill', 'pokemon-tcg-classic-venusaur-18-bill'),
  ('pok-mon-go-64-blanche', 'pokemon-go-64-blanche'),
  ('pok-mon-go-17-blastoise', 'pokemon-go-17-blastoise'),
  ('pok-mon-tcg-classic-blastoise-3-blastoise', 'pokemon-tcg-classic-blastoise-3-blastoise'),
  ('pok-mon-go-52-blissey', 'pokemon-go-52-blissey'),
  ('pok-mon-tcg-classic-blastoise-19-boss-s-orders', 'pokemon-tcg-classic-blastoise-19-boss-s-orders'),
  ('pok-mon-tcg-classic-charizard-19-boss-s-orders', 'pokemon-tcg-classic-charizard-19-boss-s-orders'),
  ('pok-mon-tcg-classic-venusaur-19-boss-s-orders', 'pokemon-tcg-classic-venusaur-19-boss-s-orders'),
  ('pok-mon-go-1-bulbasaur', 'pokemon-go-1-bulbasaur'),
  ('pok-mon-tcg-classic-venusaur-1-bulbasaur', 'pokemon-tcg-classic-venusaur-1-bulbasaur'),
  ('pok-mon-go-14-camerupt', 'pokemon-go-14-camerupt'),
  ('pok-mon-go-65-candela', 'pokemon-go-65-candela'),
  ('pok-mon-go-51-chansey', 'pokemon-go-51-chansey'),
  ('pok-mon-tcg-classic-venusaur-15-chansey', 'pokemon-tcg-classic-venusaur-15-chansey'),
  ('pok-mon-go-10-charizard', 'pokemon-go-10-charizard'),
  ('pok-mon-tcg-classic-charizard-3-charizard', 'pokemon-tcg-classic-charizard-3-charizard'),
  ('pok-mon-go-8-charmander', 'pokemon-go-8-charmander'),
  ('pok-mon-tcg-classic-charizard-1-charmander', 'pokemon-tcg-classic-charizard-1-charmander'),
  ('pok-mon-go-9-charmeleon', 'pokemon-go-9-charmeleon'),
  ('pok-mon-tcg-classic-charizard-2-charmeleon', 'pokemon-tcg-classic-charizard-2-charmeleon'),
  ('pok-mon-rumble-2-cherrim', 'pokemon-rumble-2-cherrim'),
  ('pok-mon-tcg-classic-charizard-14-clefable', 'pokemon-tcg-classic-charizard-14-clefable'),
  ('pok-mon-tcg-classic-charizard-13-clefairy', 'pokemon-tcg-classic-charizard-13-clefairy'),
  ('pok-mon-tcg-classic-blastoise-20-computer-search', 'pokemon-tcg-classic-blastoise-20-computer-search'),
  ('pok-mon-tcg-classic-charizard-20-computer-search', 'pokemon-tcg-classic-charizard-20-computer-search'),
  ('pok-mon-tcg-classic-venusaur-20-computer-search', 'pokemon-tcg-classic-venusaur-20-computer-search'),
  ('pok-mon-go-40-conkeldurr-v', 'pokemon-go-40-conkeldurr-v'),
  ('pok-mon-go-73-conkeldurr-v', 'pokemon-go-73-conkeldurr-v'),
  ('pok-mon-go-74-conkeldurr-v', 'pokemon-go-74-conkeldurr-v'),
  ('pok-mon-go-53-ditto', 'pokemon-go-53-ditto'),
  ('pok-mon-tcg-classic-venusaur-14-dodrio', 'pokemon-tcg-classic-venusaur-14-dodrio'),
  ('pok-mon-tcg-classic-venusaur-13-doduo', 'pokemon-tcg-classic-venusaur-13-doduo'),
  ('pok-mon-tcg-classic-blastoise-32-double-colorless-energy', 'pokemon-tcg-classic-blastoise-32-double-colorless-energy'),
  ('pok-mon-tcg-classic-charizard-32-double-colorless-energy', 'pokemon-tcg-classic-charizard-32-double-colorless-energy'),
  ('pok-mon-tcg-classic-venusaur-32-double-colorless-energy', 'pokemon-tcg-classic-venusaur-32-double-colorless-energy'),
  ('pok-mon-go-49-dragonite-v', 'pokemon-go-49-dragonite-v'),
  ('pok-mon-go-76-dragonite-v', 'pokemon-go-76-dragonite-v'),
  ('pok-mon-go-50-dragonite-vstar', 'pokemon-go-50-dragonite-vstar'),
  ('pok-mon-go-81-dragonite-vstar', 'pokemon-go-81-dragonite-vstar'),
  ('pok-mon-tcg-classic-blastoise-21-drops-in-the-ocean', 'pokemon-tcg-classic-blastoise-21-drops-in-the-ocean'),
  ('pok-mon-tcg-classic-blastoise-11-drowzee', 'pokemon-tcg-classic-blastoise-11-drowzee'),
  ('pok-mon-tcg-classic-charizard-15-dunsparce', 'pokemon-tcg-classic-charizard-15-dunsparce'),
  ('pok-mon-go-54-eevee', 'pokemon-go-54-eevee'),
  ('pok-mon-futsal-collection-2-eevee-on-the-ball', 'pokemon-futsal-collection-2-eevee-on-the-ball'),
  ('pok-mon-go-66-egg-incubator', 'pokemon-go-66-egg-incubator'),
  ('pok-mon-tcg-classic-charizard-11-electrode', 'pokemon-tcg-classic-charizard-11-electrode'),
  ('pok-mon-tcg-classic-blastoise-22-fisherman', 'pokemon-tcg-classic-blastoise-22-fisherman'),
  ('pok-mon-go-26-golisopod', 'pokemon-go-26-golisopod'),
  ('pok-mon-futsal-collection-3-grookey-on-the-ball', 'pokemon-futsal-collection-3-grookey-on-the-ball'),
  ('pok-mon-go-22-gyarados', 'pokemon-go-22-gyarados'),
  ('pok-mon-tcg-classic-blastoise-7-gyarados', 'pokemon-tcg-classic-blastoise-7-gyarados'),
  ('pok-mon-tcg-classic-venusaur-12-hitmonchan', 'pokemon-tcg-classic-venusaur-12-hitmonchan'),
  ('pok-mon-tcg-classic-venusaur-11-hitmonlee', 'pokemon-tcg-classic-venusaur-11-hitmonlee'),
  ('pok-mon-tcg-classic-charizard-7-ho-oh-ex', 'pokemon-tcg-classic-charizard-7-ho-oh-ex'),
  ('pok-mon-tcg-classic-blastoise-12-hypno', 'pokemon-tcg-classic-blastoise-12-hypno'),
  ('pok-mon-go-2-ivysaur', 'pokemon-go-2-ivysaur'),
  ('pok-mon-tcg-classic-venusaur-2-ivysaur', 'pokemon-tcg-classic-venusaur-2-ivysaur'),
  ('pok-mon-tcg-classic-blastoise-17-kangaskhan', 'pokemon-tcg-classic-blastoise-17-kangaskhan'),
  ('pok-mon-go-23-lapras', 'pokemon-go-23-lapras'),
  ('pok-mon-tcg-classic-blastoise-8-lapras', 'pokemon-tcg-classic-blastoise-8-lapras'),
  ('pok-mon-go-37-larvitar', 'pokemon-go-37-larvitar'),
  ('pok-mon-tcg-classic-blastoise-16-lt-surge-s-raticate', 'pokemon-tcg-classic-blastoise-16-lt-surge-s-raticate'),
  ('pok-mon-tcg-classic-blastoise-15-lt-surge-s-rattata', 'pokemon-tcg-classic-blastoise-15-lt-surge-s-rattata'),
  ('pok-mon-tcg-classic-venusaur-17-lugia-ex', 'pokemon-tcg-classic-venusaur-17-lugia-ex'),
  ('pok-mon-go-34-lunatone', 'pokemon-go-34-lunatone'),
  ('pok-mon-go-67-lure-module', 'pokemon-go-67-lure-module'),
  ('pok-mon-go-21-magikarp', 'pokemon-go-21-magikarp'),
  ('pok-mon-tcg-classic-blastoise-6-magikarp', 'pokemon-tcg-classic-blastoise-6-magikarp'),
  ('pok-mon-tcg-classic-charizard-6-magmar', 'pokemon-tcg-classic-charizard-6-magmar'),
  ('pok-mon-go-46-melmetal', 'pokemon-go-46-melmetal'),
  ('pok-mon-go-47-melmetal-v', 'pokemon-go-47-melmetal-v'),
  ('pok-mon-go-75-melmetal-v', 'pokemon-go-75-melmetal-v'),
  ('pok-mon-go-48-melmetal-vmax', 'pokemon-go-48-melmetal-vmax'),
  ('pok-mon-go-80-melmetal-vmax', 'pokemon-go-80-melmetal-vmax'),
  ('pok-mon-go-45-meltan', 'pokemon-go-45-meltan'),
  ('pok-mon-tcg-classic-blastoise-14-mewtwo', 'pokemon-tcg-classic-blastoise-14-mewtwo'),
  ('pok-mon-go-30-mewtwo-v', 'pokemon-go-30-mewtwo-v'),
  ('pok-mon-go-72-mewtwo-v', 'pokemon-go-72-mewtwo-v'),
  ('pok-mon-go-31-mewtwo-vstar', 'pokemon-go-31-mewtwo-vstar'),
  ('pok-mon-go-79-mewtwo-vstar', 'pokemon-go-79-mewtwo-vstar'),
  ('pok-mon-go-86-mewtwo-vstar', 'pokemon-go-86-mewtwo-vstar'),
  ('pok-mon-tcg-classic-charizard-17-miltank', 'pokemon-tcg-classic-charizard-17-miltank'),
  ('pok-mon-go-12-moltres', 'pokemon-go-12-moltres'),
  ('pok-mon-tcg-classic-blastoise-13-mr-mime', 'pokemon-tcg-classic-blastoise-13-mr-mime'),
  ('pok-mon-go-32-natu', 'pokemon-go-32-natu'),
  ('pok-mon-rumble-3-ninetales', 'pokemon-rumble-3-ninetales'),
  ('pok-mon-go-13-numel', 'pokemon-go-13-numel'),
  ('pok-mon-go-36-onix', 'pokemon-go-36-onix'),
  ('pok-mon-tcg-classic-venusaur-10-onix', 'pokemon-tcg-classic-venusaur-10-onix'),
  ('pok-mon-tcg-classic-venusaur-4-paras', 'pokemon-tcg-classic-venusaur-4-paras'),
  ('pok-mon-tcg-classic-venusaur-5-parasect', 'pokemon-tcg-classic-venusaur-5-parasect'),
  ('pok-mon-go-61-pidove', 'pokemon-go-61-pidove'),
  ('pok-mon-go-27-pikachu', 'pokemon-go-27-pikachu'),
  ('pok-mon-go-28-pikachu', 'pokemon-go-28-pikachu'),
  ('pok-mon-tcg-classic-charizard-8-pikachu', 'pokemon-tcg-classic-charizard-8-pikachu'),
  ('pok-mon-futsal-collection-1-pikachu-on-the-ball', 'pokemon-futsal-collection-1-pikachu-on-the-ball'),
  ('pok-mon-tcg-classic-venusaur-7-pinsir', 'pokemon-tcg-classic-venusaur-7-pinsir'),
  ('champion-s-path-59-pok-ball', 'champion-s-path-59-poke-ball'),
  ('crown-zenith-137-pok-ball', 'crown-zenith-137-poke-ball'),
  ('pok-mon-tcg-classic-blastoise-23-pok-ball', 'pokemon-tcg-classic-blastoise-23-poke-ball'),
  ('pok-mon-tcg-classic-charizard-21-pok-ball', 'pokemon-tcg-classic-charizard-21-poke-ball'),
  ('pok-mon-tcg-classic-venusaur-21-pok-ball', 'pokemon-tcg-classic-venusaur-21-poke-ball'),
  ('promo-a-5-pok-ball', 'promo-a-5-poke-ball'),
  ('rebel-clash-164-pok-ball', 'rebel-clash-164-poke-ball'),
  ('scarlet-violet-185-pok-ball', 'scarlet-violet-185-poke-ball'),
  ('shining-revelry-111-pok-ball', 'shining-revelry-111-poke-ball'),
  ('swsh-black-star-promos-swsh146-pok-ball', 'swsh-black-star-promos-swsh146-poke-ball'),
  ('darkness-ablaze-166-pok-mon-breeder-s-nurturing', 'darkness-ablaze-166-pokemon-breeder-s-nurturing'),
  ('darkness-ablaze-188-pok-mon-breeder-s-nurturing', 'darkness-ablaze-188-pokemon-breeder-s-nurturing'),
  ('darkness-ablaze-195-pok-mon-breeder-s-nurturing', 'darkness-ablaze-195-pokemon-breeder-s-nurturing'),
  ('crown-zenith-138-pok-mon-catcher', 'crown-zenith-138-pokemon-catcher'),
  ('scarlet-violet-187-pok-mon-catcher', 'scarlet-violet-187-pokemon-catcher'),
  ('sword-shield-175-pok-mon-catcher', 'sword-shield-175-pokemon-catcher'),
  ('champion-s-path-60-pok-mon-center-lady', 'champion-s-path-60-pokemon-center-lady'),
  ('hidden-fates-64-pok-mon-center-lady', 'hidden-fates-64-pokemon-center-lady'),
  ('mega-evolution-123-pok-mon-center-lady', 'mega-evolution-123-pokemon-center-lady'),
  ('shining-revelry-70-pok-mon-center-lady', 'shining-revelry-70-pokemon-center-lady'),
  ('shining-revelry-89-pok-mon-center-lady', 'shining-revelry-89-pokemon-center-lady'),
  ('sword-shield-176-pok-mon-center-lady', 'sword-shield-176-pokemon-center-lady'),
  ('vivid-voltage-185-pok-mon-center-lady', 'vivid-voltage-185-pokemon-center-lady'),
  ('deluxe-pack-ex-316-pok-mon-communication', 'deluxe-pack-ex-316-pokemon-communication'),
  ('deluxe-pack-ex-317-pok-mon-communication', 'deluxe-pack-ex-317-pokemon-communication'),
  ('space-time-smackdown-146-pok-mon-communication', 'space-time-smackdown-146-pokemon-communication'),
  ('pok-mon-tcg-classic-blastoise-24-pok-mon-fan-club', 'pokemon-tcg-classic-blastoise-24-pokemon-fan-club'),
  ('pok-mon-tcg-classic-charizard-22-pok-mon-fan-club', 'pokemon-tcg-classic-charizard-22-pokemon-fan-club'),
  ('pok-mon-tcg-classic-venusaur-22-pok-mon-fan-club', 'pokemon-tcg-classic-venusaur-22-pokemon-fan-club'),
  ('mythical-island-64-pok-mon-flute', 'mythical-island-64-pokemon-flute'),
  ('obsidian-flames-192-pok-mon-league-headquarters', 'obsidian-flames-192-pokemon-league-headquarters'),
  ('pok-mon-tcg-classic-venusaur-23-pok-mon-nurse', 'pokemon-tcg-classic-venusaur-23-pokemon-nurse'),
  ('pok-mon-tcg-classic-charizard-4-ponyta', 'pokemon-tcg-classic-charizard-4-ponyta'),
  ('pok-mon-tcg-classic-blastoise-25-professor-oak', 'pokemon-tcg-classic-blastoise-25-professor-oak'),
  ('pok-mon-tcg-classic-charizard-23-professor-oak', 'pokemon-tcg-classic-charizard-23-professor-oak'),
  ('pok-mon-tcg-classic-venusaur-24-professor-oak', 'pokemon-tcg-classic-venusaur-24-professor-oak'),
  ('pok-mon-go-84-professor-s-research', 'pokemon-go-84-professor-s-research'),
  ('pok-mon-go-38-pupitar', 'pokemon-go-38-pupitar'),
  ('pok-mon-go-18-radiant-blastoise', 'pokemon-go-18-radiant-blastoise'),
  ('pok-mon-go-11-radiant-charizard', 'pokemon-go-11-radiant-charizard'),
  ('pok-mon-go-4-radiant-venusaur', 'pokemon-go-4-radiant-venusaur'),
  ('pok-mon-tcg-classic-charizard-9-raichu', 'pokemon-tcg-classic-charizard-9-raichu'),
  ('pok-mon-tcg-classic-charizard-5-rapidash', 'pokemon-tcg-classic-charizard-5-rapidash'),
  ('pok-mon-go-69-rare-candy', 'pokemon-go-69-rare-candy'),
  ('pok-mon-tcg-classic-blastoise-26-rare-candy', 'pokemon-tcg-classic-blastoise-26-rare-candy'),
  ('pok-mon-tcg-classic-charizard-24-rare-candy', 'pokemon-tcg-classic-charizard-24-rare-candy'),
  ('pok-mon-tcg-classic-venusaur-25-rare-candy', 'pokemon-tcg-classic-venusaur-25-rare-candy'),
  ('pok-mon-tcg-classic-blastoise-27-rocket-s-admin', 'pokemon-tcg-classic-blastoise-27-rocket-s-admin'),
  ('pok-mon-tcg-classic-charizard-25-rocket-s-admin', 'pokemon-tcg-classic-charizard-25-rocket-s-admin'),
  ('pok-mon-tcg-classic-venusaur-26-rocket-s-admin', 'pokemon-tcg-classic-venusaur-26-rocket-s-admin'),
  ('pok-mon-tcg-classic-venusaur-8-sandshrew', 'pokemon-tcg-classic-venusaur-8-sandshrew'),
  ('pok-mon-tcg-classic-venusaur-9-sandslash', 'pokemon-tcg-classic-venusaur-9-sandslash'),
  ('pok-mon-futsal-collection-4-scorbunny-on-the-ball', 'pokemon-futsal-collection-4-scorbunny-on-the-ball'),
  ('pok-mon-tcg-classic-charizard-26-scorching-charcoal', 'pokemon-tcg-classic-charizard-26-scorching-charcoal'),
  ('pok-mon-tcg-classic-venusaur-6-scyther', 'pokemon-tcg-classic-venusaur-6-scyther'),
  ('pok-mon-go-58-slaking-v', 'pokemon-go-58-slaking-v'),
  ('pok-mon-go-77-slaking-v', 'pokemon-go-77-slaking-v'),
  ('pok-mon-go-20-slowbro', 'pokemon-go-20-slowbro'),
  ('pok-mon-go-19-slowpoke', 'pokemon-go-19-slowpoke'),
  ('pok-mon-go-55-snorlax', 'pokemon-go-55-snorlax'),
  ('pok-mon-tcg-classic-venusaur-16-snorlax', 'pokemon-tcg-classic-venusaur-16-snorlax'),
  ('pok-mon-futsal-collection-5-sobble-on-the-ball', 'pokemon-futsal-collection-5-sobble-on-the-ball'),
  ('pok-mon-go-39-solrock', 'pokemon-go-39-solrock'),
  ('pok-mon-go-70-spark', 'pokemon-go-70-spark'),
  ('pok-mon-go-6-spinarak', 'pokemon-go-6-spinarak'),
  ('pok-mon-go-15-squirtle', 'pokemon-go-15-squirtle'),
  ('pok-mon-tcg-classic-blastoise-1-squirtle', 'pokemon-tcg-classic-blastoise-1-squirtle'),
  ('pok-mon-tcg-classic-charizard-16-stantler', 'pokemon-tcg-classic-charizard-16-stantler'),
  ('pok-mon-tcg-classic-blastoise-5-starmie', 'pokemon-tcg-classic-blastoise-5-starmie'),
  ('pok-mon-tcg-classic-blastoise-4-staryu', 'pokemon-tcg-classic-blastoise-4-staryu'),
  ('pok-mon-go-44-steelix', 'pokemon-go-44-steelix'),
  ('pok-mon-tcg-classic-blastoise-10-suicune-ex', 'pokemon-tcg-classic-blastoise-10-suicune-ex'),
  ('pok-mon-tcg-classic-venusaur-27-sun-seed', 'pokemon-tcg-classic-venusaur-27-sun-seed'),
  ('pok-mon-tcg-classic-blastoise-28-super-rod', 'pokemon-tcg-classic-blastoise-28-super-rod'),
  ('pok-mon-tcg-classic-charizard-27-super-rod', 'pokemon-tcg-classic-charizard-27-super-rod'),
  ('pok-mon-tcg-classic-venusaur-28-super-rod', 'pokemon-tcg-classic-venusaur-28-super-rod'),
  ('pok-mon-tcg-classic-charizard-28-super-scoop-up', 'pokemon-tcg-classic-charizard-28-super-scoop-up'),
  ('pok-mon-tcg-classic-blastoise-29-switch', 'pokemon-tcg-classic-blastoise-29-switch'),
  ('pok-mon-tcg-classic-charizard-29-switch', 'pokemon-tcg-classic-charizard-29-switch'),
  ('pok-mon-tcg-classic-venusaur-29-switch', 'pokemon-tcg-classic-venusaur-29-switch'),
  ('pok-mon-go-35-sylveon', 'pokemon-go-35-sylveon'),
  ('pok-mon-go-62-tranquill', 'pokemon-go-62-tranquill'),
  ('pok-mon-go-43-tyranitar', 'pokemon-go-43-tyranitar'),
  ('pok-mon-tcg-classic-blastoise-30-ultra-ball', 'pokemon-tcg-classic-blastoise-30-ultra-ball'),
  ('pok-mon-tcg-classic-charizard-30-ultra-ball', 'pokemon-tcg-classic-charizard-30-ultra-ball'),
  ('pok-mon-tcg-classic-venusaur-30-ultra-ball', 'pokemon-tcg-classic-venusaur-30-ultra-ball'),
  ('pok-mon-go-63-unfezant', 'pokemon-go-63-unfezant'),
  ('pok-mon-go-3-venusaur', 'pokemon-go-3-venusaur'),
  ('pok-mon-rumble-1-venusaur', 'pokemon-rumble-1-venusaur'),
  ('pok-mon-tcg-classic-venusaur-3-venusaur', 'pokemon-tcg-classic-venusaur-3-venusaur'),
  ('pok-mon-tcg-classic-charizard-10-voltorb', 'pokemon-tcg-classic-charizard-10-voltorb'),
  ('pok-mon-tcg-classic-blastoise-31-vs-seeker', 'pokemon-tcg-classic-blastoise-31-vs-seeker'),
  ('pok-mon-tcg-classic-charizard-31-vs-seeker', 'pokemon-tcg-classic-charizard-31-vs-seeker'),
  ('pok-mon-tcg-classic-venusaur-31-vs-seeker', 'pokemon-tcg-classic-venusaur-31-vs-seeker'),
  ('pok-mon-go-16-wartortle', 'pokemon-go-16-wartortle'),
  ('pok-mon-tcg-classic-blastoise-2-wartortle', 'pokemon-tcg-classic-blastoise-2-wartortle'),
  ('pok-mon-go-25-wimpod', 'pokemon-go-25-wimpod'),
  ('pok-mon-go-33-xatu', 'pokemon-go-33-xatu'),
  ('pok-mon-go-29-zapdos', 'pokemon-go-29-zapdos'),
  ('pok-mon-tcg-classic-charizard-12-zapdos', 'pokemon-tcg-classic-charizard-12-zapdos'),
  -- ── 7 missed pairs (required double-substitution to match) ────────
  ('pok-mon-go-68-pok-stop', 'pokemon-go-68-pokestop'),
  ('pok-mon-go-78-professor-s-research', 'pokemon-go-78-professor-s-research'),
  ('pok-mon-go-82-blanche', 'pokemon-go-82-blanche'),
  ('pok-mon-go-83-candela', 'pokemon-go-83-candela'),
  ('pok-mon-go-85-spark', 'pokemon-go-85-spark'),
  ('pok-mon-go-87-egg-incubator', 'pokemon-go-87-egg-incubator'),
  ('pok-mon-go-88-lure-module', 'pokemon-go-88-lure-module')
ON CONFLICT (loser_slug) DO NOTHING;

-- ── 2 true orphans: only the bug version exists ──────────────────────
-- These need INSERT-new + UPDATE-children + DELETE-old, not dedup.
-- Stored alongside the plan but with NULL winner so the loop branches.
CREATE TEMP TABLE _orphan_plan(orphan_slug text PRIMARY KEY, fixed_slug text NOT NULL);
INSERT INTO _orphan_plan(orphan_slug, fixed_slug) VALUES
  ('perfect-order-80-pok-ball', 'perfect-order-80-poke-ball'),
  ('perfect-order-82-pok-mon-catcher', 'perfect-order-82-pokemon-catcher')
ON CONFLICT (orphan_slug) DO NOTHING;

-- ── Apply the dedup plan ─────────────────────────────────────────────
DO $$
DECLARE
  pair_rec RECORD;
  orphan_rec RECORD;
BEGIN
  -- Paired dedup: skip rows where the loser is already gone (idempotency).
  FOR pair_rec IN
    SELECT loser_slug, winner_slug FROM _dedupe_plan
    WHERE EXISTS (SELECT 1 FROM canonical_cards WHERE slug = _dedupe_plan.loser_slug)
  LOOP
    -- card_aliases: UNIQUE on (alias, canonical_slug) — conflict-delete required.
    DELETE FROM card_aliases ca
    WHERE ca.canonical_slug = pair_rec.loser_slug
      AND EXISTS (
        SELECT 1 FROM card_aliases winner_ca
        WHERE winner_ca.canonical_slug = pair_rec.winner_slug
          AND winner_ca.alias = ca.alias
      );
    UPDATE card_aliases SET canonical_slug = pair_rec.winner_slug
    WHERE canonical_slug = pair_rec.loser_slug;

    -- card_page_views: no slug-based unique constraint — plain UPDATE is safe.
    UPDATE card_page_views SET canonical_slug = pair_rec.winner_slug
    WHERE canonical_slug = pair_rec.loser_slug;

    -- card_printings: UNIQUE on (source, source_id) only — plain UPDATE.
    UPDATE card_printings SET canonical_slug = pair_rec.winner_slug
    WHERE canonical_slug = pair_rec.loser_slug;

    -- DELETE the loser canonical_cards row. ON DELETE CASCADE on every
    -- child FK handles any rows we didn't explicitly migrate.
    DELETE FROM canonical_cards WHERE slug = pair_rec.loser_slug;
  END LOOP;

  -- Orphan rename: skip rows where the orphan is already gone (idempotency).
  FOR orphan_rec IN
    SELECT orphan_slug, fixed_slug FROM _orphan_plan
    WHERE EXISTS (SELECT 1 FROM canonical_cards WHERE slug = _orphan_plan.orphan_slug)
  LOOP
    -- INSERT new row at the fixed slug, copying the orphan's data. Skip
    -- if already exists (shouldn't happen for true orphans, but defensive).
    IF NOT EXISTS (SELECT 1 FROM canonical_cards WHERE slug = orphan_rec.fixed_slug) THEN
      INSERT INTO canonical_cards (
        slug, canonical_name, subject, set_name, year, card_number, language, variant,
        created_at, search_doc, search_doc_norm,
        primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url,
        image_mirrored_at, image_mirror_attempts, image_mirror_last_error,
        image_embed_attempts, image_embed_last_error, image_embedded_at,
        source
      )
      SELECT
        orphan_rec.fixed_slug, canonical_name, subject, set_name, year, card_number, language, variant,
        created_at, search_doc, search_doc_norm,
        primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url,
        image_mirrored_at, image_mirror_attempts, image_mirror_last_error,
        image_embed_attempts, image_embed_last_error, image_embedded_at,
        source
      FROM canonical_cards
      WHERE slug = orphan_rec.orphan_slug;
    END IF;

    -- Reassign all child rows to the fixed slug. card_aliases needs
    -- conflict-delete because of the (alias, canonical_slug) UNIQUE.
    UPDATE card_aliases SET canonical_slug = orphan_rec.fixed_slug
    WHERE canonical_slug = orphan_rec.orphan_slug
      AND NOT EXISTS (
        SELECT 1 FROM card_aliases winner_ca
        WHERE winner_ca.canonical_slug = orphan_rec.fixed_slug
          AND winner_ca.alias = card_aliases.alias
      );
    UPDATE card_page_views SET canonical_slug = orphan_rec.fixed_slug
    WHERE canonical_slug = orphan_rec.orphan_slug;
    UPDATE card_printings SET canonical_slug = orphan_rec.fixed_slug
    WHERE canonical_slug = orphan_rec.orphan_slug;

    DELETE FROM canonical_cards WHERE slug = orphan_rec.orphan_slug;
  END LOOP;
END $$;

-- ── Post-migration assertion: zero accent-bug rows in canonical_cards ─
DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM canonical_cards
  WHERE slug LIKE '%pok-mon-%' OR slug LIKE '%pok-ball%' OR slug LIKE '%pok-stop%';

  IF remaining > 0 THEN
    RAISE EXCEPTION 'Migration left % accent-bug rows in canonical_cards', remaining;
  END IF;
END $$;

DROP TABLE _dedupe_plan;
DROP TABLE _orphan_plan;

COMMIT;
