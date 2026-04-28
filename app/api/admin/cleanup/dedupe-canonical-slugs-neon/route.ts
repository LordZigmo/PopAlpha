/**
 * One-shot cleanup: dedupe canonical_slug accent-bug rows in Neon's
 * card_image_embeddings table.
 *
 * Companion to the Supabase-side cleanup that already ran via MCP
 * (canonical_raw_provider_parity, card_aliases, card_page_views,
 * card_image_embeddings Supabase mirror, scan_eval_images). Neon's
 * card_image_embeddings is a separate database accessed via
 * @vercel/postgres at runtime by the scanner kNN, so it needed its
 * own cleanup pass.
 *
 * Hosted as an API route (rather than a one-off local script) because
 * .env.local has empty POSTGRES_URL on the operator's machine. Vercel
 * runtime has the real connection string baked in via project env.
 *
 * Trust: cron — Authorization: Bearer CRON_SECRET. requireCron also
 * accepts ADMIN_SECRET, so either works. Classified as a cron-trust
 * route in the registry even though the path lives under admin/cleanup
 * (the path describes intent, the trust contract describes auth).
 *
 * Idempotent: re-running is a no-op once losers are cleaned.
 *
 * Removes after the migration ships and verifies. Treat as a
 * disposable one-shot.
 */

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { requireCron } from "@/lib/auth/require";

export const runtime = "nodejs";
export const maxDuration = 60;

// 216 (loser, winner) pairs from the canonical_slug_dedup_plan table
// in Supabase. Embedded here for self-containment.
const PLAN: Array<[string, string]> = [
  ["pok-mon-go-56-aipom", "pokemon-go-56-aipom"],
  ["pok-mon-go-5-alolan-exeggutor-v", "pokemon-go-5-alolan-exeggutor-v"],
  ["pok-mon-go-71-alolan-exeggutor-v", "pokemon-go-71-alolan-exeggutor-v"],
  ["pok-mon-go-42-alolan-raticate", "pokemon-go-42-alolan-raticate"],
  ["pok-mon-go-41-alolan-rattata", "pokemon-go-41-alolan-rattata"],
  ["pok-mon-go-57-ambipom", "pokemon-go-57-ambipom"],
  ["pok-mon-go-7-ariados", "pokemon-go-7-ariados"],
  ["pok-mon-go-24-articuno", "pokemon-go-24-articuno"],
  ["pok-mon-tcg-classic-blastoise-9-articuno", "pokemon-tcg-classic-blastoise-9-articuno"],
  ["pok-mon-tcg-classic-venusaur-34-basic-fighting-energy", "pokemon-tcg-classic-venusaur-34-basic-fighting-energy"],
  ["pok-mon-tcg-classic-charizard-33-basic-fire-energy", "pokemon-tcg-classic-charizard-33-basic-fire-energy"],
  ["pok-mon-tcg-classic-venusaur-33-basic-grass-energy", "pokemon-tcg-classic-venusaur-33-basic-grass-energy"],
  ["pok-mon-tcg-classic-charizard-34-basic-lightning-energy", "pokemon-tcg-classic-charizard-34-basic-lightning-energy"],
  ["pok-mon-tcg-classic-blastoise-34-basic-psychic-energy", "pokemon-tcg-classic-blastoise-34-basic-psychic-energy"],
  ["pok-mon-tcg-classic-blastoise-33-basic-water-energy", "pokemon-tcg-classic-blastoise-33-basic-water-energy"],
  ["pok-mon-go-60-bibarel", "pokemon-go-60-bibarel"],
  ["pok-mon-go-59-bidoof", "pokemon-go-59-bidoof"],
  ["pok-mon-tcg-classic-blastoise-18-bill", "pokemon-tcg-classic-blastoise-18-bill"],
  ["pok-mon-tcg-classic-charizard-18-bill", "pokemon-tcg-classic-charizard-18-bill"],
  ["pok-mon-tcg-classic-venusaur-18-bill", "pokemon-tcg-classic-venusaur-18-bill"],
  ["pok-mon-go-64-blanche", "pokemon-go-64-blanche"],
  ["pok-mon-go-17-blastoise", "pokemon-go-17-blastoise"],
  ["pok-mon-tcg-classic-blastoise-3-blastoise", "pokemon-tcg-classic-blastoise-3-blastoise"],
  ["pok-mon-go-52-blissey", "pokemon-go-52-blissey"],
  ["pok-mon-tcg-classic-blastoise-19-boss-s-orders", "pokemon-tcg-classic-blastoise-19-boss-s-orders"],
  ["pok-mon-tcg-classic-charizard-19-boss-s-orders", "pokemon-tcg-classic-charizard-19-boss-s-orders"],
  ["pok-mon-tcg-classic-venusaur-19-boss-s-orders", "pokemon-tcg-classic-venusaur-19-boss-s-orders"],
  ["pok-mon-go-1-bulbasaur", "pokemon-go-1-bulbasaur"],
  ["pok-mon-tcg-classic-venusaur-1-bulbasaur", "pokemon-tcg-classic-venusaur-1-bulbasaur"],
  ["pok-mon-go-14-camerupt", "pokemon-go-14-camerupt"],
  ["pok-mon-go-65-candela", "pokemon-go-65-candela"],
  ["pok-mon-go-51-chansey", "pokemon-go-51-chansey"],
  ["pok-mon-tcg-classic-venusaur-15-chansey", "pokemon-tcg-classic-venusaur-15-chansey"],
  ["pok-mon-go-10-charizard", "pokemon-go-10-charizard"],
  ["pok-mon-tcg-classic-charizard-3-charizard", "pokemon-tcg-classic-charizard-3-charizard"],
  ["pok-mon-go-8-charmander", "pokemon-go-8-charmander"],
  ["pok-mon-tcg-classic-charizard-1-charmander", "pokemon-tcg-classic-charizard-1-charmander"],
  ["pok-mon-go-9-charmeleon", "pokemon-go-9-charmeleon"],
  ["pok-mon-tcg-classic-charizard-2-charmeleon", "pokemon-tcg-classic-charizard-2-charmeleon"],
  ["pok-mon-rumble-2-cherrim", "pokemon-rumble-2-cherrim"],
  ["pok-mon-tcg-classic-charizard-14-clefable", "pokemon-tcg-classic-charizard-14-clefable"],
  ["pok-mon-tcg-classic-charizard-13-clefairy", "pokemon-tcg-classic-charizard-13-clefairy"],
  ["pok-mon-tcg-classic-blastoise-20-computer-search", "pokemon-tcg-classic-blastoise-20-computer-search"],
  ["pok-mon-tcg-classic-charizard-20-computer-search", "pokemon-tcg-classic-charizard-20-computer-search"],
  ["pok-mon-tcg-classic-venusaur-20-computer-search", "pokemon-tcg-classic-venusaur-20-computer-search"],
  ["pok-mon-go-40-conkeldurr-v", "pokemon-go-40-conkeldurr-v"],
  ["pok-mon-go-73-conkeldurr-v", "pokemon-go-73-conkeldurr-v"],
  ["pok-mon-go-74-conkeldurr-v", "pokemon-go-74-conkeldurr-v"],
  ["pok-mon-go-53-ditto", "pokemon-go-53-ditto"],
  ["pok-mon-tcg-classic-venusaur-14-dodrio", "pokemon-tcg-classic-venusaur-14-dodrio"],
  ["pok-mon-tcg-classic-venusaur-13-doduo", "pokemon-tcg-classic-venusaur-13-doduo"],
  ["pok-mon-tcg-classic-blastoise-32-double-colorless-energy", "pokemon-tcg-classic-blastoise-32-double-colorless-energy"],
  ["pok-mon-tcg-classic-charizard-32-double-colorless-energy", "pokemon-tcg-classic-charizard-32-double-colorless-energy"],
  ["pok-mon-tcg-classic-venusaur-32-double-colorless-energy", "pokemon-tcg-classic-venusaur-32-double-colorless-energy"],
  ["pok-mon-go-49-dragonite-v", "pokemon-go-49-dragonite-v"],
  ["pok-mon-go-76-dragonite-v", "pokemon-go-76-dragonite-v"],
  ["pok-mon-go-50-dragonite-vstar", "pokemon-go-50-dragonite-vstar"],
  ["pok-mon-go-81-dragonite-vstar", "pokemon-go-81-dragonite-vstar"],
  ["pok-mon-tcg-classic-blastoise-21-drops-in-the-ocean", "pokemon-tcg-classic-blastoise-21-drops-in-the-ocean"],
  ["pok-mon-tcg-classic-blastoise-11-drowzee", "pokemon-tcg-classic-blastoise-11-drowzee"],
  ["pok-mon-tcg-classic-charizard-15-dunsparce", "pokemon-tcg-classic-charizard-15-dunsparce"],
  ["pok-mon-go-54-eevee", "pokemon-go-54-eevee"],
  ["pok-mon-futsal-collection-2-eevee-on-the-ball", "pokemon-futsal-collection-2-eevee-on-the-ball"],
  ["pok-mon-go-66-egg-incubator", "pokemon-go-66-egg-incubator"],
  ["pok-mon-tcg-classic-charizard-11-electrode", "pokemon-tcg-classic-charizard-11-electrode"],
  ["pok-mon-tcg-classic-blastoise-22-fisherman", "pokemon-tcg-classic-blastoise-22-fisherman"],
  ["pok-mon-go-26-golisopod", "pokemon-go-26-golisopod"],
  ["pok-mon-futsal-collection-3-grookey-on-the-ball", "pokemon-futsal-collection-3-grookey-on-the-ball"],
  ["pok-mon-go-22-gyarados", "pokemon-go-22-gyarados"],
  ["pok-mon-tcg-classic-blastoise-7-gyarados", "pokemon-tcg-classic-blastoise-7-gyarados"],
  ["pok-mon-tcg-classic-venusaur-12-hitmonchan", "pokemon-tcg-classic-venusaur-12-hitmonchan"],
  ["pok-mon-tcg-classic-venusaur-11-hitmonlee", "pokemon-tcg-classic-venusaur-11-hitmonlee"],
  ["pok-mon-tcg-classic-charizard-7-ho-oh-ex", "pokemon-tcg-classic-charizard-7-ho-oh-ex"],
  ["pok-mon-tcg-classic-blastoise-12-hypno", "pokemon-tcg-classic-blastoise-12-hypno"],
  ["pok-mon-go-2-ivysaur", "pokemon-go-2-ivysaur"],
  ["pok-mon-tcg-classic-venusaur-2-ivysaur", "pokemon-tcg-classic-venusaur-2-ivysaur"],
  ["pok-mon-tcg-classic-blastoise-17-kangaskhan", "pokemon-tcg-classic-blastoise-17-kangaskhan"],
  ["pok-mon-go-23-lapras", "pokemon-go-23-lapras"],
  ["pok-mon-tcg-classic-blastoise-8-lapras", "pokemon-tcg-classic-blastoise-8-lapras"],
  ["pok-mon-go-37-larvitar", "pokemon-go-37-larvitar"],
  ["pok-mon-tcg-classic-blastoise-16-lt-surge-s-raticate", "pokemon-tcg-classic-blastoise-16-lt-surge-s-raticate"],
  ["pok-mon-tcg-classic-blastoise-15-lt-surge-s-rattata", "pokemon-tcg-classic-blastoise-15-lt-surge-s-rattata"],
  ["pok-mon-tcg-classic-venusaur-17-lugia-ex", "pokemon-tcg-classic-venusaur-17-lugia-ex"],
  ["pok-mon-go-34-lunatone", "pokemon-go-34-lunatone"],
  ["pok-mon-go-67-lure-module", "pokemon-go-67-lure-module"],
  ["pok-mon-go-21-magikarp", "pokemon-go-21-magikarp"],
  ["pok-mon-tcg-classic-blastoise-6-magikarp", "pokemon-tcg-classic-blastoise-6-magikarp"],
  ["pok-mon-tcg-classic-charizard-6-magmar", "pokemon-tcg-classic-charizard-6-magmar"],
  ["pok-mon-go-46-melmetal", "pokemon-go-46-melmetal"],
  ["pok-mon-go-47-melmetal-v", "pokemon-go-47-melmetal-v"],
  ["pok-mon-go-75-melmetal-v", "pokemon-go-75-melmetal-v"],
  ["pok-mon-go-48-melmetal-vmax", "pokemon-go-48-melmetal-vmax"],
  ["pok-mon-go-80-melmetal-vmax", "pokemon-go-80-melmetal-vmax"],
  ["pok-mon-go-45-meltan", "pokemon-go-45-meltan"],
  ["pok-mon-tcg-classic-blastoise-14-mewtwo", "pokemon-tcg-classic-blastoise-14-mewtwo"],
  ["pok-mon-go-30-mewtwo-v", "pokemon-go-30-mewtwo-v"],
  ["pok-mon-go-72-mewtwo-v", "pokemon-go-72-mewtwo-v"],
  ["pok-mon-go-31-mewtwo-vstar", "pokemon-go-31-mewtwo-vstar"],
  ["pok-mon-go-79-mewtwo-vstar", "pokemon-go-79-mewtwo-vstar"],
  ["pok-mon-go-86-mewtwo-vstar", "pokemon-go-86-mewtwo-vstar"],
  ["pok-mon-tcg-classic-charizard-17-miltank", "pokemon-tcg-classic-charizard-17-miltank"],
  ["pok-mon-go-12-moltres", "pokemon-go-12-moltres"],
  ["pok-mon-tcg-classic-blastoise-13-mr-mime", "pokemon-tcg-classic-blastoise-13-mr-mime"],
  ["pok-mon-go-32-natu", "pokemon-go-32-natu"],
  ["pok-mon-rumble-3-ninetales", "pokemon-rumble-3-ninetales"],
  ["pok-mon-go-13-numel", "pokemon-go-13-numel"],
  ["pok-mon-go-36-onix", "pokemon-go-36-onix"],
  ["pok-mon-tcg-classic-venusaur-10-onix", "pokemon-tcg-classic-venusaur-10-onix"],
  ["pok-mon-tcg-classic-venusaur-4-paras", "pokemon-tcg-classic-venusaur-4-paras"],
  ["pok-mon-tcg-classic-venusaur-5-parasect", "pokemon-tcg-classic-venusaur-5-parasect"],
  ["pok-mon-go-61-pidove", "pokemon-go-61-pidove"],
  ["pok-mon-go-27-pikachu", "pokemon-go-27-pikachu"],
  ["pok-mon-go-28-pikachu", "pokemon-go-28-pikachu"],
  ["pok-mon-tcg-classic-charizard-8-pikachu", "pokemon-tcg-classic-charizard-8-pikachu"],
  ["pok-mon-futsal-collection-1-pikachu-on-the-ball", "pokemon-futsal-collection-1-pikachu-on-the-ball"],
  ["pok-mon-tcg-classic-venusaur-7-pinsir", "pokemon-tcg-classic-venusaur-7-pinsir"],
  ["champion-s-path-59-pok-ball", "champion-s-path-59-poke-ball"],
  ["crown-zenith-137-pok-ball", "crown-zenith-137-poke-ball"],
  ["pok-mon-tcg-classic-blastoise-23-pok-ball", "pokemon-tcg-classic-blastoise-23-poke-ball"],
  ["pok-mon-tcg-classic-charizard-21-pok-ball", "pokemon-tcg-classic-charizard-21-poke-ball"],
  ["pok-mon-tcg-classic-venusaur-21-pok-ball", "pokemon-tcg-classic-venusaur-21-poke-ball"],
  ["promo-a-5-pok-ball", "promo-a-5-poke-ball"],
  ["rebel-clash-164-pok-ball", "rebel-clash-164-poke-ball"],
  ["scarlet-violet-185-pok-ball", "scarlet-violet-185-poke-ball"],
  ["shining-revelry-111-pok-ball", "shining-revelry-111-poke-ball"],
  ["swsh-black-star-promos-swsh146-pok-ball", "swsh-black-star-promos-swsh146-poke-ball"],
  ["darkness-ablaze-166-pok-mon-breeder-s-nurturing", "darkness-ablaze-166-pokemon-breeder-s-nurturing"],
  ["darkness-ablaze-188-pok-mon-breeder-s-nurturing", "darkness-ablaze-188-pokemon-breeder-s-nurturing"],
  ["darkness-ablaze-195-pok-mon-breeder-s-nurturing", "darkness-ablaze-195-pokemon-breeder-s-nurturing"],
  ["crown-zenith-138-pok-mon-catcher", "crown-zenith-138-pokemon-catcher"],
  ["scarlet-violet-187-pok-mon-catcher", "scarlet-violet-187-pokemon-catcher"],
  ["sword-shield-175-pok-mon-catcher", "sword-shield-175-pokemon-catcher"],
  ["champion-s-path-60-pok-mon-center-lady", "champion-s-path-60-pokemon-center-lady"],
  ["hidden-fates-64-pok-mon-center-lady", "hidden-fates-64-pokemon-center-lady"],
  ["mega-evolution-123-pok-mon-center-lady", "mega-evolution-123-pokemon-center-lady"],
  ["shining-revelry-70-pok-mon-center-lady", "shining-revelry-70-pokemon-center-lady"],
  ["shining-revelry-89-pok-mon-center-lady", "shining-revelry-89-pokemon-center-lady"],
  ["sword-shield-176-pok-mon-center-lady", "sword-shield-176-pokemon-center-lady"],
  ["vivid-voltage-185-pok-mon-center-lady", "vivid-voltage-185-pokemon-center-lady"],
  ["deluxe-pack-ex-316-pok-mon-communication", "deluxe-pack-ex-316-pokemon-communication"],
  ["deluxe-pack-ex-317-pok-mon-communication", "deluxe-pack-ex-317-pokemon-communication"],
  ["space-time-smackdown-146-pok-mon-communication", "space-time-smackdown-146-pokemon-communication"],
  ["pok-mon-tcg-classic-blastoise-24-pok-mon-fan-club", "pokemon-tcg-classic-blastoise-24-pokemon-fan-club"],
  ["pok-mon-tcg-classic-charizard-22-pok-mon-fan-club", "pokemon-tcg-classic-charizard-22-pokemon-fan-club"],
  ["pok-mon-tcg-classic-venusaur-22-pok-mon-fan-club", "pokemon-tcg-classic-venusaur-22-pokemon-fan-club"],
  ["mythical-island-64-pok-mon-flute", "mythical-island-64-pokemon-flute"],
  ["obsidian-flames-192-pok-mon-league-headquarters", "obsidian-flames-192-pokemon-league-headquarters"],
  ["pok-mon-tcg-classic-venusaur-23-pok-mon-nurse", "pokemon-tcg-classic-venusaur-23-pokemon-nurse"],
  ["pok-mon-tcg-classic-charizard-4-ponyta", "pokemon-tcg-classic-charizard-4-ponyta"],
  ["pok-mon-tcg-classic-blastoise-25-professor-oak", "pokemon-tcg-classic-blastoise-25-professor-oak"],
  ["pok-mon-tcg-classic-charizard-23-professor-oak", "pokemon-tcg-classic-charizard-23-professor-oak"],
  ["pok-mon-tcg-classic-venusaur-24-professor-oak", "pokemon-tcg-classic-venusaur-24-professor-oak"],
  ["pok-mon-go-84-professor-s-research", "pokemon-go-84-professor-s-research"],
  ["pok-mon-go-38-pupitar", "pokemon-go-38-pupitar"],
  ["pok-mon-go-18-radiant-blastoise", "pokemon-go-18-radiant-blastoise"],
  ["pok-mon-go-11-radiant-charizard", "pokemon-go-11-radiant-charizard"],
  ["pok-mon-go-4-radiant-venusaur", "pokemon-go-4-radiant-venusaur"],
  ["pok-mon-tcg-classic-charizard-9-raichu", "pokemon-tcg-classic-charizard-9-raichu"],
  ["pok-mon-tcg-classic-charizard-5-rapidash", "pokemon-tcg-classic-charizard-5-rapidash"],
  ["pok-mon-go-69-rare-candy", "pokemon-go-69-rare-candy"],
  ["pok-mon-tcg-classic-blastoise-26-rare-candy", "pokemon-tcg-classic-blastoise-26-rare-candy"],
  ["pok-mon-tcg-classic-charizard-24-rare-candy", "pokemon-tcg-classic-charizard-24-rare-candy"],
  ["pok-mon-tcg-classic-venusaur-25-rare-candy", "pokemon-tcg-classic-venusaur-25-rare-candy"],
  ["pok-mon-tcg-classic-blastoise-27-rocket-s-admin", "pokemon-tcg-classic-blastoise-27-rocket-s-admin"],
  ["pok-mon-tcg-classic-charizard-25-rocket-s-admin", "pokemon-tcg-classic-charizard-25-rocket-s-admin"],
  ["pok-mon-tcg-classic-venusaur-26-rocket-s-admin", "pokemon-tcg-classic-venusaur-26-rocket-s-admin"],
  ["pok-mon-tcg-classic-venusaur-8-sandshrew", "pokemon-tcg-classic-venusaur-8-sandshrew"],
  ["pok-mon-tcg-classic-venusaur-9-sandslash", "pokemon-tcg-classic-venusaur-9-sandslash"],
  ["pok-mon-futsal-collection-4-scorbunny-on-the-ball", "pokemon-futsal-collection-4-scorbunny-on-the-ball"],
  ["pok-mon-tcg-classic-charizard-26-scorching-charcoal", "pokemon-tcg-classic-charizard-26-scorching-charcoal"],
  ["pok-mon-tcg-classic-venusaur-6-scyther", "pokemon-tcg-classic-venusaur-6-scyther"],
  ["pok-mon-go-58-slaking-v", "pokemon-go-58-slaking-v"],
  ["pok-mon-go-77-slaking-v", "pokemon-go-77-slaking-v"],
  ["pok-mon-go-20-slowbro", "pokemon-go-20-slowbro"],
  ["pok-mon-go-19-slowpoke", "pokemon-go-19-slowpoke"],
  ["pok-mon-go-55-snorlax", "pokemon-go-55-snorlax"],
  ["pok-mon-tcg-classic-venusaur-16-snorlax", "pokemon-tcg-classic-venusaur-16-snorlax"],
  ["pok-mon-futsal-collection-5-sobble-on-the-ball", "pokemon-futsal-collection-5-sobble-on-the-ball"],
  ["pok-mon-go-39-solrock", "pokemon-go-39-solrock"],
  ["pok-mon-go-70-spark", "pokemon-go-70-spark"],
  ["pok-mon-go-6-spinarak", "pokemon-go-6-spinarak"],
  ["pok-mon-go-15-squirtle", "pokemon-go-15-squirtle"],
  ["pok-mon-tcg-classic-blastoise-1-squirtle", "pokemon-tcg-classic-blastoise-1-squirtle"],
  ["pok-mon-tcg-classic-charizard-16-stantler", "pokemon-tcg-classic-charizard-16-stantler"],
  ["pok-mon-tcg-classic-blastoise-5-starmie", "pokemon-tcg-classic-blastoise-5-starmie"],
  ["pok-mon-tcg-classic-blastoise-4-staryu", "pokemon-tcg-classic-blastoise-4-staryu"],
  ["pok-mon-go-44-steelix", "pokemon-go-44-steelix"],
  ["pok-mon-tcg-classic-blastoise-10-suicune-ex", "pokemon-tcg-classic-blastoise-10-suicune-ex"],
  ["pok-mon-tcg-classic-venusaur-27-sun-seed", "pokemon-tcg-classic-venusaur-27-sun-seed"],
  ["pok-mon-tcg-classic-blastoise-28-super-rod", "pokemon-tcg-classic-blastoise-28-super-rod"],
  ["pok-mon-tcg-classic-charizard-27-super-rod", "pokemon-tcg-classic-charizard-27-super-rod"],
  ["pok-mon-tcg-classic-venusaur-28-super-rod", "pokemon-tcg-classic-venusaur-28-super-rod"],
  ["pok-mon-tcg-classic-charizard-28-super-scoop-up", "pokemon-tcg-classic-charizard-28-super-scoop-up"],
  ["pok-mon-tcg-classic-blastoise-29-switch", "pokemon-tcg-classic-blastoise-29-switch"],
  ["pok-mon-tcg-classic-charizard-29-switch", "pokemon-tcg-classic-charizard-29-switch"],
  ["pok-mon-tcg-classic-venusaur-29-switch", "pokemon-tcg-classic-venusaur-29-switch"],
  ["pok-mon-go-35-sylveon", "pokemon-go-35-sylveon"],
  ["pok-mon-go-62-tranquill", "pokemon-go-62-tranquill"],
  ["pok-mon-go-43-tyranitar", "pokemon-go-43-tyranitar"],
  ["pok-mon-tcg-classic-blastoise-30-ultra-ball", "pokemon-tcg-classic-blastoise-30-ultra-ball"],
  ["pok-mon-tcg-classic-charizard-30-ultra-ball", "pokemon-tcg-classic-charizard-30-ultra-ball"],
  ["pok-mon-tcg-classic-venusaur-30-ultra-ball", "pokemon-tcg-classic-venusaur-30-ultra-ball"],
  ["pok-mon-go-63-unfezant", "pokemon-go-63-unfezant"],
  ["pok-mon-go-3-venusaur", "pokemon-go-3-venusaur"],
  ["pok-mon-rumble-1-venusaur", "pokemon-rumble-1-venusaur"],
  ["pok-mon-tcg-classic-venusaur-3-venusaur", "pokemon-tcg-classic-venusaur-3-venusaur"],
  ["pok-mon-tcg-classic-charizard-10-voltorb", "pokemon-tcg-classic-charizard-10-voltorb"],
  ["pok-mon-tcg-classic-blastoise-31-vs-seeker", "pokemon-tcg-classic-blastoise-31-vs-seeker"],
  ["pok-mon-tcg-classic-charizard-31-vs-seeker", "pokemon-tcg-classic-charizard-31-vs-seeker"],
  ["pok-mon-tcg-classic-venusaur-31-vs-seeker", "pokemon-tcg-classic-venusaur-31-vs-seeker"],
  ["pok-mon-go-16-wartortle", "pokemon-go-16-wartortle"],
  ["pok-mon-tcg-classic-blastoise-2-wartortle", "pokemon-tcg-classic-blastoise-2-wartortle"],
  ["pok-mon-go-25-wimpod", "pokemon-go-25-wimpod"],
  ["pok-mon-go-33-xatu", "pokemon-go-33-xatu"],
  ["pok-mon-go-29-zapdos", "pokemon-go-29-zapdos"],
  ["pok-mon-tcg-classic-charizard-12-zapdos", "pokemon-tcg-classic-charizard-12-zapdos"],
];

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const losers = PLAN.map(([l]) => l);

  const before = await sql.query<{ rows_on_losers: number }>(
    `SELECT COUNT(*)::int AS rows_on_losers FROM card_image_embeddings WHERE canonical_slug = ANY($1::text[])`,
    [losers],
  );

  if (before.rows[0].rows_on_losers === 0) {
    return NextResponse.json({
      ok: true,
      job: "dedupe_canonical_slugs_neon",
      message: "No loser-slug rows in Neon — nothing to clean.",
      rows_before: 0,
      rows_after: 0,
      conflict_deletes: 0,
      updates: 0,
      pair_errors: 0,
      durationMs: Date.now() - startedAt,
    });
  }

  let conflictDeletes = 0;
  let updates = 0;
  let pairErrors = 0;
  let firstError: string | null = null;

  for (const [loser, winner] of PLAN) {
    try {
      const deleted = await sql.query(
        `DELETE FROM card_image_embeddings cie
         WHERE cie.canonical_slug = $1
           AND EXISTS (
             SELECT 1 FROM card_image_embeddings winner_cie
             WHERE winner_cie.canonical_slug = $2
               AND winner_cie.variant_index = cie.variant_index
               AND winner_cie.crop_type = cie.crop_type
           )`,
        [loser, winner],
      );
      conflictDeletes += deleted.rowCount ?? 0;

      const updated = await sql.query(
        `UPDATE card_image_embeddings
         SET canonical_slug = $1
         WHERE canonical_slug = $2`,
        [winner, loser],
      );
      updates += updated.rowCount ?? 0;
    } catch (err) {
      pairErrors += 1;
      if (!firstError) {
        firstError = `${loser}→${winner}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  const after = await sql.query<{ rows_on_losers: number }>(
    `SELECT COUNT(*)::int AS rows_on_losers FROM card_image_embeddings WHERE canonical_slug = ANY($1::text[])`,
    [losers],
  );

  return NextResponse.json({
    ok: pairErrors === 0 && after.rows[0].rows_on_losers === 0,
    job: "dedupe_canonical_slugs_neon",
    rows_before: before.rows[0].rows_on_losers,
    rows_after: after.rows[0].rows_on_losers,
    conflict_deletes: conflictDeletes,
    updates,
    pair_errors: pairErrors,
    first_error: firstError,
    durationMs: Date.now() - startedAt,
  });
}
