#!/usr/bin/env node
/**
 * Snkrdunk product-name fetcher — Step B of the catalog-mapper sequence.
 *
 * Reads the trading-card-ID list produced by walk-snkrdunk-sitemap.mjs
 * (Step A) and fetches each ID's product name + variations via the
 * /en/v1/products/SW---<id>/variations JSON endpoint. Writes results
 * as JSONL so the operator can interrupt + resume.
 *
 * Critical finding from sampling: Snkrdunk's sitemap covers their
 * ENTIRE product inventory — clothing, figures, non-Pokemon TCGs,
 * baseball cards, plus Pokemon. The 233k sitemap IDs are NOT all
 * Pokemon. Rough estimate from 8-sample probe: ~12% are Pokemon.
 *
 * This script:
 *   1. Reads tmp/snkrdunk-trading-card-ids.json (from Step A)
 *   2. Reads existing tmp/snkrdunk-product-names.jsonl (for resume —
 *      already-fetched IDs get skipped on re-run)
 *   3. For each unprocessed ID in --offset..--offset+--limit range,
 *      fetches the /variations endpoint
 *   4. Parses the product name with parseSnkrdunkProductName
 *   5. Heuristic-flags as Pokemon if parseSnkrdunkProductName produces
 *      a parsed structure (name + setLongName) AND the setLongName
 *      mentions known Pokemon-set markers OR the pokemonName matches
 *      a glossary Pokemon name
 *   6. Appends one JSONL record per fetched ID — fields:
 *        { id, productCode, products: [...], parsed: {...}, isPokemonLikely, fetchedAt }
 *      "products" includes ALL variation entries the /variations
 *      endpoint returned (so we capture cross-printing info)
 *
 * Resume: re-running with the same --output path skips IDs that
 * already have a row in the JSONL. Safe to Ctrl-C and resume.
 *
 * Robots.txt note: this hits /en/v1/* which Snkrdunk's robots.txt
 * asks crawlers not to crawl. Same soft-violation as the price
 * pipeline. Mitigations: 1-2s polite delay + concurrency 1-3 + halt
 * on 429/403/503 + transform-not-resold downstream.
 *
 * Usage:
 *   # Smoke test — first 100 IDs
 *   node scripts/fetch-snkrdunk-names.mjs --limit=100
 *
 *   # Process IDs 100..1100
 *   node scripts/fetch-snkrdunk-names.mjs --offset=100 --limit=1000
 *
 *   # Full backfill at concurrency 3 (operator runs this when ready)
 *   node scripts/fetch-snkrdunk-names.mjs --concurrency=3
 *
 *   # Smoke with custom output for inspection
 *   node scripts/fetch-snkrdunk-names.mjs --limit=50 --output=/tmp/sample.jsonl
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSnkrdunkProductName } from "../lib/jp/snkrdunk-matcher.mjs";
import { POKEMON_NAMES } from "../lib/jp/glossary.mjs";

const DEFAULT_INPUT = "tmp/snkrdunk-trading-card-ids.json";
const DEFAULT_OUTPUT = "tmp/snkrdunk-product-names.jsonl";
const DEFAULT_DELAY_MS = 2000;
const DEFAULT_JITTER_MS = 200;
const DEFAULT_CONCURRENCY = 1;
const REQUEST_TIMEOUT_MS = 25000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================================================
// Pokemon-detection heuristic
// =============================================================================
//
// Snkrdunk product names follow a structured format that parseSnkrdunkProductName
// handles. Once parsed, we use these signals to flag as Pokemon-likely:
//   - setLongName contains "Pokemon" or "ポケモン" or a known Pokemon-era
//     set marker (Sword & Shield, Scarlet & Violet, Sun & Moon, etc.)
//   - pokemonName matches a known Pokemon-name from our glossary
//
// Both signals together = high confidence. Either alone = medium. Neither = drop.
//
// Why heuristic rather than fetch-then-match-against-canonical: the
// downstream matcher (Step C) does proper canonical_card matching.
// This is a coarse filter to avoid burning Step C cycles on
// streetwear / non-Pokemon TCGs.

const POKEMON_SET_MARKERS = [
  // English Pokemon-era markers
  "Pokemon", "Pokémon",
  // Generic Pokemon set forms (verified empirically — these phrases
  // appear in Pokemon parentheticals and not in Yu-Gi-Oh / Star Wars /
  // One Piece / Heaven Burns Red / baseball-card parentheticals,
  // which all use "Booster Pack", "Start Deck", etc.)
  "Promotional cards", "Promotional Cards",
  "Expansion Pack", "Enhanced Expansion Pack",
  "Half Deck", "Concept Pack", "Strength Expansion",
  // "Start Deck N" appears as Pokemon ("Start Deck 100" 2022 release) but
  // also as baseball ("Pacific League Start Deck ..."). Match anyway —
  // Step C's canonical_cards match rejects non-Pokemon false positives.
  "Start Deck",
  // Modern Pokemon set names
  "Sword & Shield", "Scarlet & Violet", "Sun & Moon", "XY", "Black & White",
  "Diamond & Pearl", "HeartGold", "SoulSilver",
  // Promotional cards
  "S-P Promotional", "SV-P Promotional", "PMCG-P Promotional",
  "Champion's Path", "Battle Styles", "Chilling Reign", "Evolving Skies",
  "Fusion Strike", "Brilliant Stars", "Astral Radiance", "Lost Origin",
  "Silver Tempest", "Crown Zenith", "Paldea Evolved", "Obsidian Flames",
  "Paradox Rift", "Paldean Fates", "Temporal Forces", "Twilight Masquerade",
  "Shrouded Fable", "Stellar Crown", "Surging Sparks",
  // Vintage Pokemon
  "Base Set", "Jungle", "Fossil", "Team Rocket", "Gym Heroes", "Gym Challenge",
  "Neo Genesis", "Neo Discovery", "Neo Revelation", "Neo Destiny",
  // Japanese set names
  "拡張パック", // Expansion Pack (== Base Set)
  "ポケットモンスター",
];

// Structural setCode patterns Pokemon uses but other TCGs don't:
//   - S<digit>[letter]: S1, S10, S10a, S10b, S10D, S10P, S11, S12  (Sword & Shield era)
//   - SV<digit>: SV1, SV2, SV3, ... (Scarlet & Violet era)
//   - Anything with "-P" suffix: S-P, SV-P, PMCG-P, BW-P, XY-P, SM-P
// Yu-Gi-Oh uses codes like "PSD04", One Piece uses "OP01", Star Wars "SW/S49"
// (slash), Heaven Burns Red "HBR/W103" — these don't match the regex below.
const POKEMON_SETCODE_PATTERNS = [
  /^S\d/i,           // S1, S10, S10a, S10b, S10D, S10P, S11, S12
  /^SV\d/i,          // SV1, SV2, SV3, ...
  /-P$/i,            // S-P, SV-P, PMCG-P, BW-P, XY-P, SM-P
  /^(BW|XY|SM|HG|RG|DP|EX|EX1)\d/i, // older Pokemon eras
];

// Lowercase-cache the Pokemon-name set so the per-ID check is O(1).
const POKEMON_NAMES_LOWERCASE_SET = (() => {
  const s = new Set();
  for (const [jp, en] of Object.entries(POKEMON_NAMES)) {
    if (typeof jp === "string") s.add(jp.toLowerCase());
    if (typeof en === "string" && !en.startsWith("(")) s.add(en.toLowerCase());
  }
  return s;
})();

function isPokemonLikely(parsed) {
  if (!parsed) return false;
  // Signal 1: setLongName mentions a Pokemon-specific marker
  const set = parsed.setLongName ?? "";
  if (set) {
    const lowered = set.toLowerCase();
    for (const marker of POKEMON_SET_MARKERS) {
      if (lowered.includes(marker.toLowerCase())) return true;
    }
  }
  // Signal 2: setCode matches a structural Pokemon pattern.
  // Catches "Arezu SR[S10a 086/071](Enhanced Expansion Pack \"Dark Phantasma\")"
  // where the setLongName doesn't mention "Pokemon" by name but the setCode
  // (S10a) is Pokemon-exclusive structure.
  const setCode = parsed.setCode ?? "";
  if (setCode) {
    for (const pattern of POKEMON_SETCODE_PATTERNS) {
      if (pattern.test(setCode)) return true;
    }
  }
  // Signal 3: pokemonName starts with a glossary Pokemon name OR has a
  // regional/form prefix followed by one (e.g., "Hisuian Zoroark VSTAR UR"
  // → check "Zoroark"; "Radiant Charizard K" → check "Charizard").
  const name = parsed.pokemonName ?? "";
  if (!name) return false;
  const tokens = name.split(/\s+/);
  if (tokens.length === 0) return false;
  const POKEMON_FORM_PREFIXES = new Set([
    "alolan", "galarian", "hisuian", "paldean", "radiant",
    "shining", "shadow", "dark", "light", "delta",
  ]);
  // First token check
  if (POKEMON_NAMES_LOWERCASE_SET.has(tokens[0].toLowerCase())) return true;
  // First token is a form-prefix → check second token
  if (tokens.length >= 2 && POKEMON_FORM_PREFIXES.has(tokens[0].toLowerCase())) {
    if (POKEMON_NAMES_LOWERCASE_SET.has(tokens[1].toLowerCase())) return true;
  }
  // Trainer-prefixed cards: "Erika's Charizard", "Brock's Onix"
  if (tokens.length >= 2) {
    if (tokens[0].toLowerCase().endsWith("'s") || tokens[0].toLowerCase().endsWith("’s")) {
      const second = tokens[1].toLowerCase();
      if (POKEMON_NAMES_LOWERCASE_SET.has(second)) return true;
    }
  }
  return false;
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    offset: 0,
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    delayMs: DEFAULT_DELAY_MS,
    quiet: false,
    pokemonOnly: false,
  };
  for (const a of args) {
    if (a.startsWith("--input=")) opts.input = a.slice("--input=".length);
    else if (a.startsWith("--output=")) opts.output = a.slice("--output=".length);
    else if (a.startsWith("--offset=")) opts.offset = Math.max(0, Number.parseInt(a.slice("--offset=".length), 10) || 0);
    else if (a.startsWith("--limit=")) opts.limit = Math.max(1, Number.parseInt(a.slice("--limit=".length), 10) || 1);
    else if (a.startsWith("--concurrency=")) opts.concurrency = Math.max(1, Math.min(4, Number.parseInt(a.slice("--concurrency=".length), 10) || 1));
    else if (a.startsWith("--delay=")) opts.delayMs = Math.max(100, Number.parseInt(a.slice("--delay=".length), 10) || 100);
    else if (a === "--pokemon-only") opts.pokemonOnly = true;
    else if (a === "--quiet") opts.quiet = true;
  }
  return opts;
}

class SnkrdunkPushbackError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url} — Snkrdunk pushback (halt the run)`);
    this.status = status;
    this.url = url;
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, */*",
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status === 429 || res.status === 403 || res.status === 503) {
      throw new SnkrdunkPushbackError(res.status, url);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchOne(id) {
  const productCode = `SW---${id}`;
  const url = `https://snkrdunk.com/en/v1/products/${productCode}/variations`;
  const res = await fetchJson(url);
  // /variations returns { products: [{id, code, name, type, thumbnailUrl, cautionNote}, ...] }
  // Sometimes returns null or an empty products array for IDs that don't have variations.
  const products = Array.isArray(res?.products) ? res.products : [];
  // Find the product for THIS specific id (the request id)
  const primary = products.find((p) => p?.id === id) ?? products[0] ?? null;
  const primaryName = primary?.name ?? null;
  const parsed = primaryName ? parseSnkrdunkProductName(primaryName) : null;
  return {
    id,
    productCode,
    products: products.map((p) => ({
      id: p?.id ?? null,
      code: p?.code ?? null,
      name: p?.name ?? null,
      type: p?.type ?? null,
    })),
    primaryName,
    parsed,
    isPokemonLikely: isPokemonLikely(parsed),
    fetchedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const opts = parseArgs(process.argv);
  const log = (...args) => opts.quiet || console.log("[fetch-snkrdunk-names]", ...args);

  const inputPath = resolve(opts.input);
  if (!existsSync(inputPath)) {
    console.error(`[fetch-snkrdunk-names] input not found: ${inputPath}`);
    console.error(`Run scripts/walk-snkrdunk-sitemap.mjs first.`);
    process.exit(1);
  }
  const inputData = JSON.parse(readFileSync(inputPath, "utf8"));
  const allIds = Array.isArray(inputData?.ids) ? inputData.ids : [];
  if (allIds.length === 0) {
    console.error("[fetch-snkrdunk-names] input contains no IDs");
    process.exit(1);
  }
  log(`loaded ${allIds.length} ID(s) from ${inputPath}`);

  // Apply offset + limit
  const start = Math.min(opts.offset, allIds.length);
  const end = opts.limit != null ? Math.min(start + opts.limit, allIds.length) : allIds.length;
  const range = allIds.slice(start, end);
  log(`range: offset ${start}..${end} (${range.length} ID(s))`);

  // Resume: read existing output, build set of IDs already processed
  const outputPath = resolve(opts.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  const alreadyProcessed = new Set();
  if (existsSync(outputPath)) {
    const lines = readFileSync(outputPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj?.id === "number") alreadyProcessed.add(obj.id);
      } catch {
        // ignore corrupt lines
      }
    }
    log(`resume: ${alreadyProcessed.size} ID(s) already in ${outputPath}`);
  }

  const todo = range.filter((id) => !alreadyProcessed.has(id));
  log(`todo: ${todo.length} ID(s) after resume filter`);
  if (todo.length === 0) {
    log("nothing to do — exiting");
    return;
  }

  // Polite, concurrent processing — fixed-size batches with inter-batch delay
  const startedAt = Date.now();
  let processed = 0;
  let pokemonCount = 0;
  let errorCount = 0;
  let halted = false;
  let haltReason = null;

  outer:
  for (let i = 0; i < todo.length; i += opts.concurrency) {
    const batch = todo.slice(i, i + opts.concurrency);
    let results;
    try {
      results = await Promise.all(
        batch.map(async (id) => {
          try {
            return { ok: true, value: await fetchOne(id) };
          } catch (err) {
            if (err instanceof SnkrdunkPushbackError) throw err;
            return { ok: false, id, error: err.message ?? String(err) };
          }
        }),
      );
    } catch (err) {
      if (err instanceof SnkrdunkPushbackError) {
        halted = true;
        haltReason = err.message;
        console.error(`[fetch-snkrdunk-names] AUTO-HALT: ${haltReason}`);
        break outer;
      }
      throw err;
    }

    // Append results to JSONL
    const lines = [];
    for (const r of results) {
      if (r.ok) {
        const row = r.value;
        if (!opts.pokemonOnly || row.isPokemonLikely) {
          lines.push(JSON.stringify(row));
        }
        if (row.isPokemonLikely) pokemonCount += 1;
      } else {
        // Record failures inline so resume can decide whether to retry
        lines.push(JSON.stringify({ id: r.id, error: r.error, fetchedAt: new Date().toISOString() }));
        errorCount += 1;
      }
    }
    if (lines.length > 0) {
      appendFileSync(outputPath, lines.join("\n") + "\n");
    }
    processed += batch.length;

    // Status every 100 cards
    if (processed % 100 === 0 || processed === todo.length) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const rate = processed / Math.max(0.1, elapsedSec);
      const remaining = todo.length - processed;
      const etaSec = remaining / Math.max(0.001, rate);
      log(
        `${processed}/${todo.length}  pokemon=${pokemonCount} err=${errorCount}  ${rate.toFixed(2)} req/s  ETA ${(etaSec / 60).toFixed(1)}min`,
      );
    }

    // Polite inter-batch delay
    if (i + opts.concurrency < todo.length) {
      const jitter = Math.random() * DEFAULT_JITTER_MS;
      await sleep(opts.delayMs + jitter);
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("");
  log(`DONE in ${elapsedSec}s — processed ${processed}/${todo.length}`);
  log(`pokemon-likely: ${pokemonCount}  errors: ${errorCount}`);
  log(`output: ${outputPath}`);
  if (halted) {
    log(`HALTED: ${haltReason}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[fetch-snkrdunk-names] FATAL:", err);
  process.exit(1);
});
