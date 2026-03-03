/**
 * map-pokemon-tcg-api-sets.mjs
 *
 * One-time script to populate provider_set_map with POKEMON_TCG_API mappings.
 * Fetches all 174 episodes (sets) from the Pokemon TCG API and fuzzy-matches
 * them to our canonical sets via set_name and set_code.
 *
 * Usage:
 *   node --env-file=.env.local scripts/map-pokemon-tcg-api-sets.mjs
 *   node --env-file=.env.local scripts/map-pokemon-tcg-api-sets.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const PROVIDER = "POKEMON_TCG_API";
const HOST = "pokemon-tcg-api.p.rapidapi.com";
const BASE_URL = `https://${HOST}`;

const dryRun = process.argv.includes("--dry-run");

// ── Env ──────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POKEMON_TCG_API_KEY = process.env.POKEMON_TCG_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!POKEMON_TCG_API_KEY) {
  console.error("Missing POKEMON_TCG_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Rate limiter ─────────────────────────────────────────────────────────────

let lastRequestTime = 0;

async function apiFetch(path) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 200) await new Promise((r) => setTimeout(r, 200 - elapsed));
  lastRequestTime = Date.now();

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "x-rapidapi-host": HOST,
      "x-rapidapi-key": POKEMON_TCG_API_KEY,
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Fetch all episodes ───────────────────────────────────────────────────────

async function fetchAllEpisodes() {
  const all = [];
  let page = 1;
  while (page <= 20) {
    const { status, body } = await apiFetch(`/episodes?page=${page}`);
    if (status < 200 || status >= 300 || !body?.data?.length) break;
    all.push(...body.data);
    if (!body.links?.next) break;
    page++;
  }
  return all;
}

// ── Set name matching ────────────────────────────────────────────────────────

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[—–]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMatch(apiName, ourName) {
  const a = normalize(apiName);
  const b = normalize(ourName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  const intersection = [...aTokens].filter((t) => bTokens.has(t)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  if (union === 0) return 0;
  return Math.round((intersection / union) * 70);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[map-pokemon-tcg-api-sets] Starting${dryRun ? " (DRY RUN)" : ""}...`);

  // 1. Fetch all episodes from Pokemon TCG API
  console.log("[1/3] Fetching episodes from Pokemon TCG API...");
  const episodes = await fetchAllEpisodes();
  console.log(`  → ${episodes.length} episodes fetched`);

  // 2. Load our canonical sets
  console.log("[2/3] Loading canonical sets from card_printings...");
  const allSets = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("set_code, set_name")
      .range(offset, offset + pageSize - 1);
    if (error) {
      console.error("Failed to load sets:", error.message);
      process.exit(1);
    }
    allSets.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  // Deduplicate by set_code
  const setMap = new Map();
  for (const row of allSets) {
    if (row.set_code && !setMap.has(row.set_code)) {
      setMap.set(row.set_code, row.set_name || row.set_code);
    }
  }
  const canonicalSets = Array.from(setMap.entries()).map(([setCode, setName]) => ({
    setCode,
    setName,
  }));
  console.log(`  → ${canonicalSets.length} unique canonical sets`);

  // 3. Match episodes to canonical sets
  console.log("[3/3] Matching episodes to canonical sets...");
  const THRESHOLD = 60;
  const upsertRows = [];
  let matched = 0;
  let unmatched = 0;

  for (const episode of episodes) {
    let bestMatch = null;
    let bestScore = 0;

    for (const cs of canonicalSets) {
      // Try name match
      const nameScore = scoreMatch(episode.name, cs.setName);
      if (nameScore > bestScore) {
        bestScore = nameScore;
        bestMatch = cs;
      }

      // Try code match if API provides one
      if (episode.code) {
        const codeExact = episode.code.toLowerCase() === cs.setCode.toLowerCase();
        if (codeExact && 100 > bestScore) {
          bestScore = 100;
          bestMatch = cs;
        }
      }
    }

    if (bestMatch && bestScore >= THRESHOLD) {
      matched++;
      const confidence = bestScore >= 85 ? 1.0 : bestScore >= 70 ? 0.8 : 0.6;
      upsertRows.push({
        provider: PROVIDER,
        canonical_set_code: bestMatch.setCode,
        canonical_set_name: bestMatch.setName,
        provider_set_id: String(episode.id),
        confidence,
      });
      console.log(
        `  ✓ "${episode.name}" (id=${episode.id}) → ${bestMatch.setCode} "${bestMatch.setName}" (score=${bestScore}, conf=${confidence})`,
      );
    } else {
      unmatched++;
      console.log(
        `  ✗ "${episode.name}" (id=${episode.id}) — no match (best score=${bestScore})`,
      );
    }
  }

  console.log(`\nMatched: ${matched}, Unmatched: ${unmatched}`);

  // 4. Upsert into provider_set_map
  if (dryRun) {
    console.log(`[DRY RUN] Would upsert ${upsertRows.length} rows into provider_set_map`);
    return;
  }

  if (upsertRows.length === 0) {
    console.log("No rows to upsert.");
    return;
  }

  console.log(`\nUpserting ${upsertRows.length} rows into provider_set_map...`);
  const BATCH_SIZE = 50;
  let totalUpserted = 0;

  for (let i = 0; i < upsertRows.length; i += BATCH_SIZE) {
    const batch = upsertRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("provider_set_map")
      .upsert(batch, { onConflict: "provider,canonical_set_code" });

    if (error) {
      console.error(`Batch ${i / BATCH_SIZE + 1} failed:`, error.message);
    } else {
      totalUpserted += batch.length;
    }
  }

  console.log(`Done. Upserted ${totalUpserted} rows.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
