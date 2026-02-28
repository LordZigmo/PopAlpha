/**
 * scripts/fetch-justtcg-raw.mjs
 *
 * Fetches raw JustTCG API responses and prints them as JSON.
 * Also optionally stores them in provider_raw_payloads via Supabase.
 *
 * Usage:
 *   JUSTTCG_API_KEY=xxx node scripts/fetch-justtcg-raw.mjs
 *   JUSTTCG_API_KEY=xxx node scripts/fetch-justtcg-raw.mjs --set sv1
 *   JUSTTCG_API_KEY=xxx node scripts/fetch-justtcg-raw.mjs --sets-only
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Config ─────────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.justtcg.com/v1";

// Load .env.local so you can just run: node scripts/fetch-justtcg-raw.mjs
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // no .env.local, rely on process.env
  }
}

loadEnv();

const API_KEY = process.env.JUSTTCG_API_KEY;
if (!API_KEY) {
  console.error("Error: JUSTTCG_API_KEY not set. Pass it as an env var or add to .env.local");
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ── Parse args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const setsOnly = args.includes("--sets-only");
const setArg = args.includes("--set") ? args[args.indexOf("--set") + 1] : null;
const save = args.includes("--save");  // save to provider_raw_payloads

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function jtFetch(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
  const body = await res.json().catch(() => null);
  return { status: res.status, url, body };
}

async function savePayload(provider, endpoint, params, response, statusCode) {
  if (!supabase || !save) return;
  const { error } = await supabase.from("provider_raw_payloads").insert({
    provider,
    endpoint,
    params,
    response,
    status_code: statusCode,
  });
  if (error) console.warn("  [warn] Could not save to provider_raw_payloads:", error.message);
  else console.error("  [saved to provider_raw_payloads]");
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.error("Fetching /sets ...");
const setsResult = await jtFetch("/sets?game=pokemon");
await savePayload("JUSTTCG", "/sets", { game: "pokemon" }, setsResult.body, setsResult.status);

if (setsOnly) {
  console.log(JSON.stringify(setsResult.body, null, 2));
  process.exit(0);
}

// If --set was provided, fetch that specific set's cards.
// Otherwise fetch the first set returned by /sets.
let targetSetId = setArg;
if (!targetSetId) {
  const sets = Array.isArray(setsResult.body)
    ? setsResult.body
    : (setsResult.body?.sets ?? setsResult.body?.data ?? []);
  const pokemonSets = sets.filter(s => !s.game || s.game.toLowerCase().includes("pokemon"));
  pokemonSets.sort((a, b) => a.id.localeCompare(b.id));
  targetSetId = pokemonSets[0]?.id;
  if (targetSetId) {
    console.error(`No --set specified; using first Pokemon set: ${targetSetId} (${pokemonSets[0]?.name})`);
  }
}

if (!targetSetId) {
  console.error("No set ID found. Use --sets-only to inspect the sets list.");
  console.log(JSON.stringify({ sets: setsResult.body }, null, 2));
  process.exit(1);
}

console.error(`Fetching /cards?set=${targetSetId} page=1 ...`);
const cardsResult = await jtFetch(`/cards?set=${encodeURIComponent(targetSetId)}&page=1&limit=250`);
await savePayload("JUSTTCG", "/cards", { set: targetSetId, page: 1, limit: 250 }, cardsResult.body, cardsResult.status);

// Output combined result so you can see both responses.
console.log(JSON.stringify({
  sets: setsResult.body,
  cards: cardsResult.body,
}, null, 2));
