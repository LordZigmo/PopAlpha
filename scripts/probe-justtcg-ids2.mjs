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

// Extended patterns for SWSH and SV sets that aren't found with simple prefix
const extendedTests = [
  // SWSH era — try swshN- prefix and also "sword-and-shield-" prefix
  ['Astral Radiance', [
    'swsh10-astral-radiance-pokemon', 'swsh-astral-radiance-pokemon',
    'sword-and-shield-astral-radiance-pokemon', 'sword-shield-astral-radiance-pokemon',
  ]],
  ['Battle Styles', [
    'swsh5-battle-styles-pokemon', 'swsh-battle-styles-pokemon',
    'sword-and-shield-battle-styles-pokemon', 'sword-shield-battle-styles-pokemon',
  ]],
  ['Brilliant Stars', [
    'swsh9-brilliant-stars-pokemon', 'swsh-brilliant-stars-pokemon',
    'sword-and-shield-brilliant-stars-pokemon', 'sword-shield-brilliant-stars-pokemon',
  ]],
  ['Chilling Reign', [
    'swsh6-chilling-reign-pokemon', 'swsh-chilling-reign-pokemon',
    'sword-and-shield-chilling-reign-pokemon', 'sword-shield-chilling-reign-pokemon',
  ]],
  ['Evolving Skies', [
    'swsh7-evolving-skies-pokemon', 'swsh-evolving-skies-pokemon',
    'sword-and-shield-evolving-skies-pokemon',
  ]],
  ['Fusion Strike', [
    'swsh8-fusion-strike-pokemon', 'swsh-fusion-strike-pokemon',
    'sword-and-shield-fusion-strike-pokemon',
  ]],
  ['Lost Origin', [
    'swsh11-lost-origin-pokemon', 'swsh-lost-origin-pokemon',
    'sword-and-shield-lost-origin-pokemon',
  ]],
  ['Silver Tempest', [
    'swsh12-silver-tempest-pokemon', 'swsh-silver-tempest-pokemon',
    'sword-and-shield-silver-tempest-pokemon',
  ]],
  ['Vivid Voltage', [
    'swsh4-vivid-voltage-pokemon', 'swsh-vivid-voltage-pokemon',
    'sword-and-shield-vivid-voltage-pokemon',
  ]],
  ['Darkness Ablaze', [
    'swsh3-darkness-ablaze-pokemon', 'swsh-darkness-ablaze-pokemon',
    'sword-and-shield-darkness-ablaze-pokemon',
  ]],
  ['Rebel Clash', [
    'swsh2-rebel-clash-pokemon', 'swsh-rebel-clash-pokemon',
    'sword-and-shield-rebel-clash-pokemon',
  ]],
  ['Sword & Shield', [
    'swsh1-sword-and-shield-pokemon', 'swsh-sword-and-shield-pokemon',
    'sword-and-shield-pokemon', 'sword-and-shield-base-pokemon',
  ]],
  // SV era
  ['Obsidian Flames', [
    'sv3-obsidian-flames-pokemon', 'sv-obsidian-flames-pokemon',
    'scarlet-and-violet-obsidian-flames-pokemon',
  ]],
  ['Paldea Evolved', [
    'sv2-paldea-evolved-pokemon', 'sv-paldea-evolved-pokemon',
    'scarlet-and-violet-paldea-evolved-pokemon',
  ]],
  ['Scarlet & Violet', [
    'sv1-scarlet-and-violet-pokemon', 'sv-scarlet-and-violet-pokemon',
    'scarlet-and-violet-pokemon', 'scarlet-and-violet-base-pokemon',
  ]],
  ['151', [
    'sv-151-pokemon', 'sv3pt5-151-pokemon', 'sv3-5-151-pokemon',
    'scarlet-and-violet-151-pokemon', 'pokemon-151-pokemon',
    'pokemon-card-151-pokemon', 'sv-pokemon-card-151-pokemon',
  ]],
  ['Temporal Forces', [
    'sv5-temporal-forces-pokemon', 'sv-temporal-forces-pokemon',
    'scarlet-and-violet-temporal-forces-pokemon',
  ]],
  ['Paradox Rift', [
    'sv4-paradox-rift-pokemon', 'sv-paradox-rift-pokemon',
    'scarlet-and-violet-paradox-rift-pokemon',
  ]],
  ['Surging Sparks', [
    'sv8-surging-sparks-pokemon', 'sv-surging-sparks-pokemon',
    'scarlet-and-violet-surging-sparks-pokemon',
  ]],
  ['Stellar Crown', [
    'sv7-stellar-crown-pokemon', 'sv-stellar-crown-pokemon',
    'scarlet-and-violet-stellar-crown-pokemon',
  ]],
  ['Twilight Masquerade', [
    'sv6-twilight-masquerade-pokemon', 'sv-twilight-masquerade-pokemon',
    'scarlet-and-violet-twilight-masquerade-pokemon',
  ]],
  ['Shrouded Fable', [
    'sv6pt5-shrouded-fable-pokemon', 'sv-shrouded-fable-pokemon',
    'scarlet-and-violet-shrouded-fable-pokemon',
  ]],
  ['Paldean Fates', [
    'sv4pt5-paldean-fates-pokemon', 'sv-paldean-fates-pokemon',
    'scarlet-and-violet-paldean-fates-pokemon',
  ]],
  // Others
  ['Base', ['base-set-pokemon', 'wotc-base-set-pokemon', 'base-pokemon', 'original-base-set-pokemon']],
  ['Ascended Heroes', [
    'me2pt5-ascended-heroes-pokemon', 'sv-ascended-heroes-pokemon',
    'me-ascended-heroes-pokemon', 'ascended-heroes-pokemon',
  ]],
];

for (const [name, ids] of extendedTests) {
  let found = false;
  for (const id of ids) {
    const count = await probe(id);
    if (count > 0) {
      console.log(`${name.padEnd(35)} ${id.padEnd(55)} ${count} cards`);
      found = true;
      break;
    }
  }
  if (!found) {
    console.log(`${name.padEnd(35)} NOT FOUND`);
  }
}
