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

// Probe a bunch of patterns systematically
const prefixes = ['', 'sv-', 'swsh-', 'sm-', 'xy-', 'bw-', 'dp-', 'ex-', 'neo-', 'wotc-'];
const setCodes = {
  // Failing sets from the backfill run — grouped by era
  // WOTC
  'base': 'Base', 'fossil': 'Fossil', 'jungle': 'Jungle',
  // XY
  'ancient-origins': 'Ancient Origins', 'breakpoint': 'BREAKpoint', 'breakthrough': 'BREAKthrough',
  // Sun & Moon
  'burning-shadows': 'Burning Shadows', 'celestial-storm': 'Celestial Storm',
  'cosmic-eclipse': 'Cosmic Eclipse', 'crimson-invasion': 'Crimson Invasion',
  // Sword & Shield
  'astral-radiance': 'Astral Radiance', 'battle-styles': 'Battle Styles',
  'brilliant-stars': 'Brilliant Stars', 'chilling-reign': 'Chilling Reign',
  // SV
  '151': '151', 'obsidian-flames': 'Obsidian Flames',
  // 2025 (re-verify)
  'black-bolt': 'Black Bolt', 'ascended-heroes': 'Ascended Heroes',
};

for (const [slug, name] of Object.entries(setCodes)) {
  let found = false;
  for (const prefix of prefixes) {
    const id = `${prefix}${slug}-pokemon`;
    const count = await probe(id);
    if (count > 0) {
      console.log(`${name.padEnd(35)} ${id.padEnd(50)} ${count} cards`);
      found = true;
      break;
    }
  }
  if (!found) {
    console.log(`${name.padEnd(35)} NOT FOUND`);
  }
}
