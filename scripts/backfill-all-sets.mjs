import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SECRET = process.env.CRON_SECRET;
const BASE = 'http://localhost:3000';
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Get all distinct set names from card_printings (EN only)
async function getAllSetNames() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await c.from('card_printings').select('set_name').eq('language', 'EN').range(from, from + 999);
    if (error) { console.error('DB error:', error.message); break; }
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return [...new Set(all.map(r => r.set_name))].sort();
}

function setNameToKey(name) {
  return name
    .replace(/&/g, 'and')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function backfillSet(setName) {
  const key = setNameToKey(setName);
  const params = new URLSearchParams({
    set: key,
    canonicalSetName: setName,
    secret: SECRET,
  });
  const url = `${BASE}/api/debug/justtcg/backfill-set?${params}`;
  const resp = await fetch(url, { method: 'POST' });
  const data = await resp.json();
  return data;
}

const skip = process.argv.includes('--skip-done');
const dryList = process.argv.includes('--list');
const startFrom = process.argv.find(a => a.startsWith('--from='))?.split('=')[1] ?? null;

const setNames = await getAllSetNames();
console.log(`Found ${setNames.length} sets in card_printings\n`);

if (dryList) {
  for (const name of setNames) {
    console.log(`${setNameToKey(name).padEnd(40)} ${name}`);
  }
  process.exit(0);
}

let started = !startFrom;
let totalMatched = 0;
let totalPrintings = 0;
let totalHistory = 0;
let setsDone = 0;
let setsFailed = 0;
let setsSkipped = 0;

for (const name of setNames) {
  if (!started) {
    if (name === startFrom || setNameToKey(name) === startFrom) {
      started = true;
    } else {
      continue;
    }
  }

  const t0 = Date.now();
  try {
    const result = await backfillSet(name);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const matched = result.matchedCount ?? 0;
    const total = result.printingsSelected ?? 0;
    const history = result.historyPointsWritten ?? 0;
    const noMatch = result.noMatchCount ?? 0;
    const requests = result.providerRequestsUsed ?? 0;

    if (result.ok) {
      totalMatched += matched;
      totalPrintings += total;
      totalHistory += history;
      setsDone++;
      console.log(`✓ ${name.padEnd(42)} ${matched}/${total} matched  ${String(history).padStart(7)} pts  ${elapsed}s  (${requests} req)`);
    } else {
      const err = (result.firstError ?? result.error ?? 'unknown').slice(0, 80);
      if (matched > 0) {
        totalMatched += matched;
        totalPrintings += total;
        totalHistory += history;
        setsDone++;
        console.log(`~ ${name.padEnd(42)} ${matched}/${total} matched  ${String(history).padStart(7)} pts  ${elapsed}s  (${requests} req)  [${noMatch} no-match]`);
      } else {
        setsFailed++;
        console.log(`✗ ${name.padEnd(42)} FAILED ${elapsed}s — ${err}`);
      }
    }
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    setsFailed++;
    console.log(`✗ ${name.padEnd(42)} ERROR ${elapsed}s — ${e.message?.slice(0, 80)}`);
  }

  // Small delay to be respectful of API rate limits
  await new Promise(r => setTimeout(r, 500));
}

console.log(`\n${'='.repeat(80)}`);
console.log(`Done: ${setsDone} sets backfilled, ${setsFailed} failed, ${setsSkipped} skipped`);
console.log(`Total: ${totalMatched}/${totalPrintings} printings matched, ${totalHistory.toLocaleString()} history points`);
