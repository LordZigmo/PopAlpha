import 'dotenv/config';

const SECRET = process.env.CRON_SECRET;
const BASE = 'http://localhost:3000';

if (!SECRET) {
  throw new Error('CRON_SECRET is required.');
}

// Sets that failed in pass 1 but have known correct JustTCG IDs from probing
const OVERRIDES = {
  // XY era
  'Ancient Origins': 'xy-ancient-origins-pokemon',
  'BREAKpoint': 'xy-breakpoint-pokemon',
  'BREAKthrough': 'xy-breakthrough-pokemon',
  // SM era
  'Burning Shadows': 'sm-burning-shadows-pokemon',
  'Celestial Storm': 'sm-celestial-storm-pokemon',
  'Cosmic Eclipse': 'sm-cosmic-eclipse-pokemon',
  'Crimson Invasion': 'sm-crimson-invasion-pokemon',
  // SWSH era
  'Astral Radiance': 'swsh10-astral-radiance-pokemon',
  'Astral Radiance Trainer Gallery': 'swsh10-astral-radiance-trainer-gallery-pokemon',
  'Lost Origin': 'swsh11-lost-origin-pokemon',
  'Silver Tempest': 'swsh12-silver-tempest-pokemon',
  // SV era
  'Paldean Fates': 'sv-paldean-fates-pokemon',
  'Shrouded Fable': 'sv-shrouded-fable-pokemon',
  // 2025
  'Ascended Heroes': 'me-ascended-heroes-pokemon',
  'Black Bolt': 'sv-black-bolt-pokemon',
  'Destined Rivals': 'sv10-destined-rivals-pokemon',
  'Journey Together': 'sv09-journey-together-pokemon',
  'Mega Evolution': 'me01-mega-evolution-pokemon',
  'Phantasmal Flames': 'me02-phantasmal-flames-pokemon',
  'Prismatic Evolutions': 'sv-prismatic-evolutions-pokemon',
  'White Flare': 'sv-white-flare-pokemon',
  // WOTC
  'Base': 'base-set-pokemon',
};

function setNameToKey(name) {
  return name.replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

let totalMatched = 0;
let totalPrintings = 0;
let totalHistory = 0;
let setsDone = 0;
let setsFailed = 0;

for (const [name, providerSetId] of Object.entries(OVERRIDES)) {
  const key = setNameToKey(name);
  const params = new URLSearchParams({
    set: key,
    canonicalSetName: name,
    providerSetId,
  });
  const url = `${BASE}/api/debug/justtcg/backfill-set?${params}`;
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET}`,
      },
    });
    const data = await resp.json();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const matched = data.matchedCount ?? 0;
    const total = data.printingsSelected ?? 0;
    const history = data.historyPointsWritten ?? 0;
    const noMatch = data.noMatchCount ?? 0;

    if (matched > 0) {
      totalMatched += matched;
      totalPrintings += total;
      totalHistory += history;
      setsDone++;
      const status = data.ok ? '✓' : '~';
      console.log(`${status} ${name.padEnd(42)} ${matched}/${total} matched  ${String(history).padStart(7)} pts  ${elapsed}s  ${noMatch > 0 ? `[${noMatch} no-match]` : ''}`);
    } else {
      setsFailed++;
      const err = (data.firstError ?? data.error ?? 'unknown').slice(0, 80);
      console.log(`✗ ${name.padEnd(42)} FAILED ${elapsed}s — ${err}`);
    }
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    setsFailed++;
    console.log(`✗ ${name.padEnd(42)} ERROR ${elapsed}s — ${e.message?.slice(0, 80)}`);
  }
  await new Promise(r => setTimeout(r, 500));
}

console.log(`\n${'='.repeat(80)}`);
console.log(`Pass 2: ${setsDone} sets backfilled, ${setsFailed} failed`);
console.log(`Total: ${totalMatched}/${totalPrintings} printings matched, ${totalHistory.toLocaleString()} history points`);
