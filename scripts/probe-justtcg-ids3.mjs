import 'dotenv/config';

const key = process.env.JUSTTCG_API_KEY;
const base = 'https://api.justtcg.com/v1';

async function probe(id) {
  const resp = await fetch(`${base}/cards?set=${encodeURIComponent(id)}&limit=1`, {
    headers: { 'x-api-key': key },
    cache: 'no-store',
  });
  const json = await resp.json().catch(() => null);
  return json?.meta?.total ?? json?.data?.length ?? 0;
}

// All sets that failed in first run — systematically try all known prefix patterns
const failingSets = [
  // Set name → set codes from our DB → slug variants to try
  { name: '151', code: 'sv3pt5', slugs: ['sv-pokemon-card-151', 'sv3-5-pokemon-card-151', 'scarlet-and-violet-151', 'pokemon-card-151', 'sv-151'] },
  { name: 'Ancient Origins', code: 'xy7', slugs: ['xy-ancient-origins', 'xy7-ancient-origins'] },
  { name: 'Ascended Heroes', code: 'me2pt5', slugs: ['me-ascended-heroes', 'me2-5-ascended-heroes', 'me2pt5-ascended-heroes'] },
  { name: 'Astral Radiance Trainer Gallery', code: 'swsh10tg', slugs: ['swsh10-astral-radiance-trainer-gallery', 'swsh-astral-radiance-trainer-gallery'] },
  { name: 'Base', code: 'base1', slugs: ['base-set', 'original-base-set', 'wotc-base-set', 'base-1'] },
  { name: 'Battle Styles', code: 'swsh5', slugs: ['swsh5-battle-styles', 'swsh-battle-styles', 'sword-and-shield-battle-styles'] },
  { name: 'Best of Game', code: 'bp', slugs: ['best-of-game', 'bp-best-of-game'] },
  { name: 'BREAKpoint', code: 'xy9', slugs: ['xy-breakpoint', 'xy9-breakpoint'] },
  { name: 'BREAKthrough', code: 'xy8', slugs: ['xy-breakthrough', 'xy8-breakthrough'] },
  { name: 'Brilliant Stars', code: 'swsh9', slugs: ['swsh9-brilliant-stars', 'swsh-brilliant-stars', 'sword-and-shield-brilliant-stars'] },
  { name: 'Brilliant Stars Trainer Gallery', code: 'swsh9tg', slugs: ['swsh9-brilliant-stars-trainer-gallery', 'swsh-brilliant-stars-trainer-gallery'] },
  { name: 'Burning Shadows', code: 'sm3', slugs: ['sm-burning-shadows', 'sm3-burning-shadows', 'sun-and-moon-burning-shadows'] },
  { name: 'BW Black Star Promos', code: 'bwp', slugs: ['bw-black-star-promos', 'bwp-black-star-promos', 'black-and-white-black-star-promos'] },
  { name: 'Celestial Storm', code: 'sm7', slugs: ['sm-celestial-storm', 'sm7-celestial-storm', 'sun-and-moon-celestial-storm'] },
  { name: 'Chilling Reign', code: 'swsh6', slugs: ['swsh6-chilling-reign', 'swsh-chilling-reign', 'sword-and-shield-chilling-reign'] },
  { name: 'Cosmic Eclipse', code: 'sm12', slugs: ['sm-cosmic-eclipse', 'sm12-cosmic-eclipse', 'sun-and-moon-cosmic-eclipse'] },
  { name: 'Crimson Invasion', code: 'sm4', slugs: ['sm-crimson-invasion', 'sm4-crimson-invasion', 'sun-and-moon-crimson-invasion'] },
  { name: 'Darkness Ablaze', code: 'swsh3', slugs: ['swsh3-darkness-ablaze', 'swsh-darkness-ablaze', 'sword-and-shield-darkness-ablaze'] },
  { name: 'Destined Rivals', code: 'sv10', slugs: ['sv10-destined-rivals', 'sv-destined-rivals', 'scarlet-and-violet-destined-rivals'] },
  { name: 'Black Bolt', code: 'zsv10pt5', slugs: ['sv-black-bolt', 'zsv10pt5-black-bolt'] },
  { name: 'DP Black Star Promos', code: 'dpp', slugs: ['dp-black-star-promos', 'dpp-black-star-promos', 'diamond-and-pearl-black-star-promos'] },
  { name: 'Evolving Skies', code: 'swsh7', slugs: ['swsh7-evolving-skies', 'swsh-evolving-skies', 'sword-and-shield-evolving-skies'] },
  { name: 'Fusion Strike', code: 'swsh8', slugs: ['swsh8-fusion-strike', 'swsh-fusion-strike', 'sword-and-shield-fusion-strike'] },
  { name: 'Obsidian Flames', code: 'sv3', slugs: ['sv3-obsidian-flames', 'sv-obsidian-flames', 'scarlet-and-violet-obsidian-flames'] },
  { name: 'Paldea Evolved', code: 'sv2', slugs: ['sv2-paldea-evolved', 'sv-paldea-evolved', 'scarlet-and-violet-paldea-evolved'] },
  { name: 'Paradox Rift', code: 'sv4', slugs: ['sv4-paradox-rift', 'sv-paradox-rift', 'scarlet-and-violet-paradox-rift'] },
  { name: 'Rebel Clash', code: 'swsh2', slugs: ['swsh2-rebel-clash', 'swsh-rebel-clash', 'sword-and-shield-rebel-clash'] },
  { name: 'Scarlet & Violet', code: 'sv1', slugs: ['sv1-scarlet-and-violet', 'sv-scarlet-and-violet', 'scarlet-and-violet', 'scarlet-and-violet-base'] },
  { name: 'SV Black Star Promos', code: 'svp', slugs: ['sv-black-star-promos', 'svp-black-star-promos', 'scarlet-and-violet-black-star-promos'] },
  { name: 'SV Energies', code: 'sve', slugs: ['sv-energies', 'sve-energies', 'scarlet-and-violet-energies'] },
  { name: 'SM Black Star Promos', code: 'smp', slugs: ['sm-black-star-promos', 'smp-black-star-promos', 'sun-and-moon-black-star-promos'] },
  { name: 'SWSH Black Star Promos', code: 'swshp', slugs: ['swsh-black-star-promos', 'swshp-black-star-promos', 'sword-and-shield-black-star-promos'] },
  { name: 'Stellar Crown', code: 'sv7', slugs: ['sv7-stellar-crown', 'sv-stellar-crown', 'scarlet-and-violet-stellar-crown'] },
  { name: 'Surging Sparks', code: 'sv8', slugs: ['sv8-surging-sparks', 'sv-surging-sparks', 'scarlet-and-violet-surging-sparks'] },
  { name: 'Sword & Shield', code: 'swsh1', slugs: ['swsh1-sword-and-shield', 'swsh-sword-and-shield', 'sword-and-shield', 'sword-and-shield-base'] },
  { name: 'Temporal Forces', code: 'sv5', slugs: ['sv5-temporal-forces', 'sv-temporal-forces', 'scarlet-and-violet-temporal-forces'] },
  { name: 'Twilight Masquerade', code: 'sv6', slugs: ['sv6-twilight-masquerade', 'sv-twilight-masquerade', 'scarlet-and-violet-twilight-masquerade'] },
  { name: 'Vivid Voltage', code: 'swsh4', slugs: ['swsh4-vivid-voltage', 'swsh-vivid-voltage', 'sword-and-shield-vivid-voltage'] },
  { name: 'Shrouded Fable', code: 'sv6pt5', slugs: ['sv-shrouded-fable', 'sv6pt5-shrouded-fable', 'scarlet-and-violet-shrouded-fable'] },
  { name: 'Paldean Fates', code: 'sv4pt5', slugs: ['sv-paldean-fates', 'sv4pt5-paldean-fates', 'scarlet-and-violet-paldean-fates'] },
];

const found = {};
const notFound = [];

for (const set of failingSets) {
  let resolved = false;
  for (const slug of set.slugs) {
    const id = slug + '-pokemon';
    const count = await probe(id);
    if (count > 0) {
      console.log(`${set.name.padEnd(40)} ${id.padEnd(55)} ${count} cards`);
      found[set.name] = id;
      resolved = true;
      break;
    }
  }
  if (!resolved) {
    console.log(`${set.name.padEnd(40)} NOT FOUND (tried ${set.slugs.length} patterns)`);
    notFound.push(set.name);
  }
}

console.log(`\n--- Found: ${Object.keys(found).length}, Not found: ${notFound.length} ---`);
if (notFound.length > 0) {
  console.log('Missing:', notFound.join(', '));
}

// Output as JSON mapping for use in backfill script
console.log('\n// Provider set ID map:');
console.log(JSON.stringify(found, null, 2));
