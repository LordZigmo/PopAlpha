/**
 * backfill-all-sets.mjs
 *
 * Maps ALL canonical set_codes to JustTCG provider_set_ids.
 * - Loads all set_codes from card_printings (paginated past 1000-row default)
 * - Loads existing provider_set_map entries
 * - For unmapped sets: probes JustTCG API with era-based candidate patterns
 * - Upserts working mappings into provider_set_map with confidence=1.0
 * - Fixes known bad mappings (e.g. base1 → base-set-pokemon)
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-all-sets.mjs
 *   node --env-file=.env.local scripts/backfill-all-sets.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const PROVIDER = "JUSTTCG";
const BASE_URL = "https://api.justtcg.com/v1";

// ── Known overrides: set_code → confirmed JustTCG provider_set_id ────────────
// Built from probe-justtcg-ids3.mjs results + manual verification.
const KNOWN_OVERRIDES = {
  // Scarlet & Violet era
  sv1: "sv01-scarlet-and-violet-pokemon",
  sv2: "sv02-paldea-evolved-pokemon",
  sv3: "sv03-obsidian-flames-pokemon",
  "sv3pt5": "scarlet-and-violet-151-pokemon",
  sv4: "sv04-paradox-rift-pokemon",
  "sv4pt5": "sv-paldean-fates-pokemon",
  sv5: "sv05-temporal-forces-pokemon",
  sv6: "sv06-twilight-masquerade-pokemon",
  "sv6pt5": "sv-shrouded-fable-pokemon",
  sv7: "sv07-stellar-crown-pokemon",
  sv8: "sv08-surging-sparks-pokemon",
  sv9: "sv09-journey-together-pokemon",
  sv10: "sv10-destined-rivals-pokemon",
  svp: "scarlet-and-violet-promos-pokemon",
  sve: "scarlet-and-violet-energies-pokemon",

  // Sword & Shield era
  swsh1: "swsh01-sword-and-shield-pokemon",
  swsh2: "swsh02-rebel-clash-pokemon",
  swsh3: "swsh03-darkness-ablaze-pokemon",
  swsh4: "swsh04-vivid-voltage-pokemon",
  swsh5: "swsh05-battle-styles-pokemon",
  swsh6: "swsh06-chilling-reign-pokemon",
  swsh7: "swsh07-evolving-skies-pokemon",
  swsh8: "swsh08-fusion-strike-pokemon",
  swsh9: "swsh09-brilliant-stars-pokemon",
  swsh10: "swsh10-astral-radiance-pokemon",
  swsh11: "swsh11-lost-origin-pokemon",
  swsh12: "swsh12-silver-tempest-pokemon",
  "swsh12pt5": "crown-zenith-pokemon",
  swshp: "sword-and-shield-promos-pokemon",

  // SWSH Trainer Galleries
  swsh9tg: "swsh09-brilliant-stars-trainer-gallery-pokemon",
  swsh10tg: "swsh10-astral-radiance-trainer-gallery-pokemon",
  swsh11tg: "swsh11-lost-origin-trainer-gallery-pokemon",
  swsh12tg: "swsh12-silver-tempest-trainer-gallery-pokemon",
  "swsh12pt5gg": "crown-zenith-galarian-gallery-pokemon",

  // Sun & Moon era
  sm1: "sm01-sun-and-moon-pokemon",
  sm2: "sm02-guardians-rising-pokemon",
  sm3: "sm03-burning-shadows-pokemon",
  "sm35": "shining-legends-pokemon",
  sm4: "sm04-crimson-invasion-pokemon",
  sm5: "sm05-ultra-prism-pokemon",
  sm6: "sm06-forbidden-light-pokemon",
  sm7: "sm07-celestial-storm-pokemon",
  "sm75": "dragon-majesty-pokemon",
  sm8: "sm08-lost-thunder-pokemon",
  sm9: "sm09-team-up-pokemon",
  sm10: "sm10-unbroken-bonds-pokemon",
  sm11: "sm11-unified-minds-pokemon",
  "sm115": "hidden-fates-pokemon",
  sm12: "sm12-cosmic-eclipse-pokemon",
  smp: "sun-and-moon-promos-pokemon",

  // XY era
  xy0: "kalos-starter-set-pokemon",
  xy1: "xy-pokemon",
  xy2: "flashfire-pokemon",
  xy3: "furious-fists-pokemon",
  xy4: "phantom-forces-pokemon",
  xy5: "primal-clash-pokemon",
  xy6: "roaring-skies-pokemon",
  xy7: "ancient-origins-pokemon",
  xy8: "breakthrough-pokemon",
  xy9: "breakpoint-pokemon",
  xy10: "fates-collide-pokemon",
  xy11: "steam-siege-pokemon",
  xy12: "evolutions-pokemon",
  xyp: "xy-promos-pokemon",
  g1: "generations-pokemon",
  dc1: "double-crisis-pokemon",

  // Black & White era
  bw1: "black-and-white-pokemon",
  bw2: "emerging-powers-pokemon",
  bw3: "noble-victories-pokemon",
  bw4: "next-destinies-pokemon",
  bw5: "dark-explorers-pokemon",
  bw6: "dragons-exalted-pokemon",
  bw7: "boundaries-crossed-pokemon",
  bw8: "plasma-storm-pokemon",
  bw9: "plasma-freeze-pokemon",
  bw10: "plasma-blast-pokemon",
  bw11: "legendary-treasures-pokemon",
  bwp: "black-and-white-promos-pokemon",

  // Diamond & Pearl era
  dp1: "diamond-and-pearl-pokemon",
  dp2: "mysterious-treasures-pokemon",
  dp3: "secret-wonders-pokemon",
  dp4: "great-encounters-pokemon",
  dp5: "majestic-dawn-pokemon",
  dp6: "legends-awakened-pokemon",
  dp7: "stormfront-pokemon",
  dpp: "diamond-and-pearl-promos-pokemon",

  // Platinum era
  pl1: "platinum-pokemon",
  pl2: "rising-rivals-pokemon",
  pl3: "supreme-victors-pokemon",
  pl4: "arceus-pokemon",

  // HeartGold/SoulSilver era
  hgss1: "heartgold-and-soulsilver-pokemon",
  hgss2: "hs-unleashed-pokemon",
  hgss3: "hs-undaunted-pokemon",
  hgss4: "hs-triumphant-pokemon",
  col1: "call-of-legends-pokemon",
  hsp: "hgss-promos-pokemon",

  // WOTC era
  base1: "base-set-pokemon",
  base2: "jungle-pokemon",
  basep: "wizards-black-star-promos-pokemon",
  base3: "fossil-pokemon",
  base4: "base-set-2-pokemon",
  base5: "team-rocket-pokemon",
  gym1: "gym-heroes-pokemon",
  gym2: "gym-challenge-pokemon",
  neo1: "neo-genesis-pokemon",
  neo2: "neo-discovery-pokemon",
  neo3: "neo-revelation-pokemon",
  neo4: "neo-destiny-pokemon",
  si1: "southern-islands-pokemon",

  // e-Card era
  ecard1: "expedition-base-set-pokemon",
  ecard2: "aquapolis-pokemon",
  ecard3: "skyridge-pokemon",

  // Ruby & Sapphire era
  ex1: "ruby-and-sapphire-pokemon",
  ex2: "sandstorm-pokemon",
  ex3: "dragon-pokemon",
  ex4: "team-magma-vs-team-aqua-pokemon",
  ex5: "hidden-legends-pokemon",
  ex6: "firered-and-leafgreen-pokemon",
  ex7: "team-rocket-returns-pokemon",
  ex8: "deoxys-pokemon",
  ex9: "emerald-pokemon",
  ex10: "unseen-forces-pokemon",
  ex11: "delta-species-pokemon",
  ex12: "legend-maker-pokemon",
  ex13: "holon-phantoms-pokemon",
  ex14: "crystal-guardians-pokemon",
  ex15: "dragon-frontiers-pokemon",
  ex16: "power-keepers-pokemon",
  pop1: "pop-series-1-pokemon",
  pop2: "pop-series-2-pokemon",
  pop3: "pop-series-3-pokemon",
  pop4: "pop-series-4-pokemon",
  pop5: "pop-series-5-pokemon",
  pop6: "pop-series-6-pokemon",
  pop7: "pop-series-7-pokemon",
  pop8: "pop-series-8-pokemon",
  pop9: "pop-series-9-pokemon",
  bp: "best-of-game-pokemon",
  np: "nintendo-promos-pokemon",
  ru1: "legendary-collection-pokemon",

  // Misc Promos/Special
  mcd11: "mcdonalds-collection-2011-pokemon",
  mcd12: "mcdonalds-collection-2012-pokemon",
  mcd14: "mcdonalds-collection-2014-pokemon",
  mcd15: "mcdonalds-collection-2015-pokemon",
  mcd16: "mcdonalds-collection-2016-pokemon",
  mcd17: "mcdonalds-collection-2017-pokemon",
  mcd18: "mcdonalds-collection-2018-pokemon",
  mcd19: "mcdonalds-collection-2019-pokemon",
  mcd21: "mcdonalds-collection-2021-pokemon",
  mcd22: "mcdonalds-collection-2022-pokemon",

  // Misc sets
  det1: "detective-pikachu-pokemon",
  "swsh35": "champions-path-pokemon",
  "swsh45": "shining-fates-pokemon",
  "swsh45sv": "shining-fates-shiny-vault-pokemon",
  "sm115sv": "hidden-fates-shiny-vault-pokemon",

  // Mask of Change / other recent sets
  sv5a: "mask-of-change-pokemon",
  "sv8pt5": "prismatic-evolutions-pokemon",

  // Destined Rivals sub-sets
  "zsv10pt5": "sv-black-bolt-pokemon",
  "rsv10pt5": "sv-white-flare-pokemon",

  // Mythical & Special Collections
  me1: "mythical-island-pokemon",
  me2: "phantasmal-flames-pokemon",
  "me2pt5": "ascended-heroes-pokemon",
};

// ── Known bad mappings to fix ────────────────────────────────────────────────
const BAD_MAPPING_FIXES = [
  { set_code: "base1", wrong_id: "me02-phantasmal-flames-pokemon", correct_id: "base-set-pokemon" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function apiKey() {
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) throw new Error("JUSTTCG_API_KEY env var not set");
  return key;
}

async function probe(id) {
  const resp = await fetch(`${BASE_URL}/cards?set=${encodeURIComponent(id)}&limit=1`, {
    headers: { "x-api-key": apiKey() },
    cache: "no-store",
  });
  const json = await resp.json().catch(() => null);
  return json?.meta?.total ?? json?.data?.length ?? 0;
}

function setNameToJustTcgId(setName) {
  return (
    setName
      .replace(/&/g, " and ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") + "-pokemon"
  );
}

/**
 * Generate candidate JustTCG IDs for a set_code + set_name.
 * Returns candidates in priority order (most likely first).
 */
function generateCandidates(setCode, setName) {
  const candidates = [];
  const slugFromName = setNameToJustTcgId(setName);
  const nameSlug = slugFromName.replace(/-pokemon$/, "");
  const code = setCode.toLowerCase();

  // SV era: sv01-..., sv-..., scarlet-and-violet-...
  if (/^sv\d/.test(code)) {
    const num = code.match(/^sv(\d+)/)?.[1];
    if (num) {
      const padded = num.padStart(2, "0");
      candidates.push(`sv${padded}-${nameSlug}-pokemon`);
      candidates.push(`sv-${nameSlug}-pokemon`);
      candidates.push(`scarlet-and-violet-${nameSlug}-pokemon`);
    }
  }

  // SWSH era: swsh01-..., swsh-..., sword-and-shield-...
  if (/^swsh\d/.test(code)) {
    const num = code.match(/^swsh(\d+)/)?.[1];
    if (num) {
      const padded = num.padStart(2, "0");
      candidates.push(`swsh${padded}-${nameSlug}-pokemon`);
      candidates.push(`swsh-${nameSlug}-pokemon`);
      candidates.push(`sword-and-shield-${nameSlug}-pokemon`);
    }
  }

  // SM era: sm01-..., sm-..., sun-and-moon-...
  if (/^sm\d/.test(code)) {
    const num = code.match(/^sm(\d+)/)?.[1];
    if (num) {
      const padded = num.padStart(2, "0");
      candidates.push(`sm${padded}-${nameSlug}-pokemon`);
      candidates.push(`sm-${nameSlug}-pokemon`);
      candidates.push(`sun-and-moon-${nameSlug}-pokemon`);
    }
  }

  // XY era
  if (/^xy\d/.test(code)) {
    candidates.push(`xy-${nameSlug}-pokemon`);
  }

  // BW era
  if (/^bw\d/.test(code)) {
    candidates.push(`black-and-white-${nameSlug}-pokemon`);
  }

  // DP era
  if (/^dp\d/.test(code)) {
    candidates.push(`diamond-and-pearl-${nameSlug}-pokemon`);
  }

  // Always try the plain slug-from-name as a fallback
  candidates.push(slugFromName);

  // Dedupe while preserving order
  return [...new Set(candidates)];
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Load ALL distinct set_codes from card_printings (paginated)
  console.log("Loading set_codes from card_printings...");
  const allSetCodes = new Map(); // set_code → set_name
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("set_code, set_name")
      .not("set_code", "is", null)
      .not("set_name", "is", null)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`card_printings query: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.set_code && row.set_name && !allSetCodes.has(row.set_code)) {
        allSetCodes.set(row.set_code, row.set_name);
      }
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  console.log(`Found ${allSetCodes.size} distinct set_codes.`);

  // 2. Load existing provider_set_map entries
  console.log("Loading existing provider_set_map...");
  const { data: existingMap, error: mapError } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code, provider_set_id, confidence")
    .eq("provider", PROVIDER);
  if (mapError) throw new Error(`provider_set_map query: ${mapError.message}`);

  const mapped = new Map();
  for (const row of existingMap ?? []) {
    mapped.set(row.canonical_set_code, {
      providerSetId: row.provider_set_id,
      confidence: Number(row.confidence ?? 0),
    });
  }
  console.log(`Existing mappings: ${mapped.size}`);

  // 3. Fix known bad mappings
  console.log("\n--- Fixing known bad mappings ---");
  for (const fix of BAD_MAPPING_FIXES) {
    const current = mapped.get(fix.set_code);
    if (current && current.providerSetId === fix.wrong_id) {
      console.log(`  FIX: ${fix.set_code}: ${fix.wrong_id} -> ${fix.correct_id}`);
      if (!dryRun) {
        const { error } = await supabase
          .from("provider_set_map")
          .update({
            provider_set_id: fix.correct_id,
            confidence: 1.0,
            last_verified_at: new Date().toISOString(),
          })
          .eq("provider", PROVIDER)
          .eq("canonical_set_code", fix.set_code);
        if (error) console.error(`    ERROR updating: ${error.message}`);
        else {
          mapped.set(fix.set_code, { providerSetId: fix.correct_id, confidence: 1.0 });
          console.log(`    Updated.`);
        }
      }
    } else if (current) {
      console.log(`  SKIP: ${fix.set_code} already has ${current.providerSetId} (not ${fix.wrong_id})`);
    }
  }

  // 4. Fix confidence=0 entries (bad slug guess, never corrected)
  console.log("\n--- Fixing confidence=0 entries ---");
  const zeroConfidence = [...mapped.entries()].filter(([, v]) => v.confidence === 0);
  for (const [setCode] of zeroConfidence) {
    const setName = allSetCodes.get(setCode);
    if (!setName) continue;

    const override = KNOWN_OVERRIDES[setCode];
    if (override) {
      console.log(`  FIX: ${setCode} (confidence=0) -> ${override}`);
      if (!dryRun) {
        const { error } = await supabase
          .from("provider_set_map")
          .update({
            provider_set_id: override,
            confidence: 1.0,
            last_verified_at: new Date().toISOString(),
          })
          .eq("provider", PROVIDER)
          .eq("canonical_set_code", setCode);
        if (error) console.error(`    ERROR: ${error.message}`);
        else {
          mapped.set(setCode, { providerSetId: override, confidence: 1.0 });
          console.log(`    Updated.`);
        }
      }
    } else {
      console.log(`  PROBE: ${setCode} (${setName}) -- no override, will probe`);
    }
  }

  // 5. Map unmapped sets
  const unmapped = [...allSetCodes.entries()].filter(([code]) => {
    const entry = mapped.get(code);
    return !entry || entry.confidence === 0;
  });
  console.log(`\n--- Mapping ${unmapped.length} unmapped/zero-confidence sets ---`);

  let newlyMapped = 0;
  let probeCount = 0;
  const notFound = [];

  for (const [setCode, setName] of unmapped) {
    // Check overrides first (no API call needed)
    const override = KNOWN_OVERRIDES[setCode];
    if (override) {
      console.log(`  ${setCode.padEnd(15)} ${setName.padEnd(35)} -> ${override} (override)`);
      if (!dryRun) {
        const { error } = await supabase
          .from("provider_set_map")
          .upsert(
            {
              provider: PROVIDER,
              canonical_set_code: setCode,
              canonical_set_name: setName,
              provider_set_id: override,
              confidence: 1.0,
              last_verified_at: new Date().toISOString(),
            },
            { onConflict: "provider,canonical_set_code" },
          );
        if (error) console.error(`    ERROR: ${error.message}`);
      }
      newlyMapped++;
      continue;
    }

    // Generate candidates and probe
    const candidates = generateCandidates(setCode, setName);
    let found = false;

    for (const candidate of candidates) {
      probeCount++;
      const count = await probe(candidate);
      if (count > 0) {
        console.log(`  ${setCode.padEnd(15)} ${setName.padEnd(35)} -> ${candidate} (${count} cards)`);
        if (!dryRun) {
          const { error } = await supabase
            .from("provider_set_map")
            .upsert(
              {
                provider: PROVIDER,
                canonical_set_code: setCode,
                canonical_set_name: setName,
                provider_set_id: candidate,
                confidence: 1.0,
                last_verified_at: new Date().toISOString(),
              },
              { onConflict: "provider,canonical_set_code" },
            );
          if (error) console.error(`    ERROR: ${error.message}`);
        }
        newlyMapped++;
        found = true;
        break;
      }
      // Rate limit: small pause between probes
      await sleep(150);
    }

    if (!found) {
      console.log(`  ${setCode.padEnd(15)} ${setName.padEnd(35)} -> NOT FOUND (tried ${candidates.length} patterns)`);
      notFound.push({ setCode, setName, candidates });
    }
  }

  // 6. Summary
  console.log("\n=== SUMMARY ===");
  console.log(`Total set_codes in DB:     ${allSetCodes.size}`);
  console.log(`Previously mapped:         ${mapped.size - zeroConfidence.length}`);
  console.log(`Newly mapped:              ${newlyMapped}`);
  console.log(`API probe calls:           ${probeCount}`);
  console.log(`Still unmapped:            ${notFound.length}`);
  if (notFound.length > 0) {
    console.log("\nUnmapped sets:");
    for (const { setCode, setName } of notFound) {
      console.log(`  ${setCode}: ${setName}`);
    }
  }
  if (dryRun) {
    console.log("\n(DRY RUN -- no changes written)");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
