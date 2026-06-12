#!/usr/bin/env node
/**
 * Snkrdunk forward-search matcher — Step B v2 of the catalog mapper.
 *
 * Replaces the brute-force "walk all 233k Snkrdunk IDs" approach
 * (scripts/walk-snkrdunk-sitemap.mjs + scripts/fetch-snkrdunk-names.mjs,
 * the latter closed in PR #53) with a forward-search:
 *
 *   For each JP canonical_card in our catalog:
 *     1. Build a search query from canonical_name (+ optional set hint)
 *     2. GET /en/v1/search?keyword=X&type=streetwear&perPage=20
 *     3. Filter results to isTradingCard=true (Snkrdunk tags these)
 *     4. parseSnkrdunkProductName on each result's `name`
 *     5. Score against the canonical card (name + set + number)
 *     6. Persist the top match (if confidence >= threshold) to JSONL
 *
 * Why forward-search beats catalog-walk for our use case:
 *   - We only care about Snkrdunk products that match a canonical_card
 *     already in our DB. The catalog-walk approach burned ~88% of its
 *     budget on streetwear/Marvel/Yu-Gi-Oh/etc. that we'd discard.
 *   - 21k searches @ 2s = ~12 hrs (vs ~22 hrs for the walk).
 *   - Each search returns up to 20 ranked candidates per canonical card,
 *     so matching is a focused score-and-pick rather than blind walking.
 *   - Snkrdunk's `isTradingCard` flag eliminates the need for our
 *     Pokemon heuristic — the search response already tags trading
 *     cards. (Non-Pokemon TCGs like Marvel still tag isTradingCard=true,
 *     but they won't score against a Pokemon canonical_card.)
 *
 * Endpoint discovered via Chrome MCP + Performance API on 2026-05-13:
 *   /en/v1/search?keyword=<q>&type=streetwear&page=<n>&perPage=<n>
 *
 * Response shape (relevant fields):
 *   {
 *     streetwearCount: 54,
 *     streetwears: [{
 *       id: 91103,                  // Snkrdunk product ID (no SW--- prefix; we prepend)
 *       name: "Charizard VMAX HR: PROMO[S-P 104](S-P Promotional cards)",
 *       minPrice: 11415,            // USD
 *       minPriceFormat: "US $11,415",
 *       listingCount: "7",
 *       isTradingCard: true,        // critical filter
 *       thumbnailUrl: "...",
 *       ...
 *     }, ...]
 *   }
 *
 * Output: JSONL with one row per canonical_slug processed:
 *   { canonical_slug, query_used, candidates: [...], best: { snkrdunk_id, name, score, ... } | null, reason }
 * The orchestrator (Step D) reads this JSONL to persist mappings.
 *
 * Resume: re-running skips canonical_slugs already in the output JSONL.
 *
 * Usage:
 *   # Smoke test on a known slug
 *   node scripts/match-snkrdunk-canonical.mjs --slug=sword-shield-promos-104-charizard-vmax-jp
 *
 *   # Process all JP canonical_cards with at least one MATCHED provider_card_map row
 *   node scripts/match-snkrdunk-canonical.mjs --all-matched-jp
 *
 *   # Subset for chunked operator runs
 *   node scripts/match-snkrdunk-canonical.mjs --all-matched-jp --offset=0 --limit=2000
 *
 * robots.txt note: this hits /en/v1/* which Snkrdunk's robots.txt asks
 * crawlers not to crawl. Same soft-violation as the price pipeline.
 * Mitigations: 2s default delay + concurrency 1-3 + halt on 429/403/503.
 */

import dotenv from "dotenv";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseSnkrdunkProductName } from "../lib/jp/snkrdunk-matcher.mjs";

dotenv.config({ path: ".env.local" });

const DEFAULT_OUTPUT = "tmp/snkrdunk-canonical-matches.jsonl";
const DEFAULT_DELAY_MS = 2000;
const DEFAULT_JITTER_MS = 300;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_PER_PAGE = 20;
const REQUEST_TIMEOUT_MS = 25000;
// Exported so the offline re-scorer (scripts/rescore-snkrdunk-jsonl.mjs) and
// smoke harness reuse the EXACT acceptance threshold instead of hardcoding it.
export const MIN_MATCH_SCORE = 0.55; // tuned: top-match needs strong name + (set OR number) signal
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SnkrdunkPushbackError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url} — Snkrdunk pushback (halt the run)`);
    this.status = status;
    this.url = url;
  }
}

async function fetchJson(url, { referer = null } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, */*",
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        ...(referer ? { "Referer": referer } : {}),
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status === 429 || res.status === 403 || res.status === 503) {
      throw new SnkrdunkPushbackError(res.status, url);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Build the keyword query for a canonical card. Strategy:
 *   1. Use canonical_name as the base (e.g. "Charizard VMAX")
 *   2. Don't include set_name in the keyword — Snkrdunk's search bar
 *      is keyword-based, and PopAlpha's set_name format ("Sword & Shield
 *      Promos") doesn't always overlap with Snkrdunk's parenthetical set
 *      ("S-P Promotional cards"). Adding it would over-narrow the
 *      results and risk zero hits.
 *
 * The set/number disambiguation happens at the SCORE step (we get up to
 * 20 candidates per query, then pick the best by matching set_code +
 * card_number).
 */
function buildQuery(card) {
  const name = (card.canonical_name ?? "").trim();
  if (!name) return null;
  return name;
}

/**
 * Map Snkrdunk setCode → likely era window [yearMin, yearMax].
 * Lets the scorer reward year-aligned matches and penalize era
 * mismatches symmetrically. Expanded post-PR #71 era audit: the
 * narrow vintage-only check missed both modern→vintage and
 * inverse-direction misalignments (e.g., a 2017 canonical mapping
 * to a `L1-S` Legend reprint from 2010-2011).
 */
export function setCodeEra(code, opts = {}) {
  // additions=false reverts to the pre-2026-06 table — used by the offline
  // re-scorer (scripts/rescore-snkrdunk-jsonl.mjs) to attribute which fix
  // unlocked a flip. Production callers never pass opts.
  const additions = opts.additions !== false;
  if (!code) return null;
  const c = code.toUpperCase();
  if (/^PMCG/.test(c)) return [1996, 2000];
  if (/^E\d/.test(c) || /^GYM/.test(c) || /^E-P/.test(c)) return [1999, 2003];
  if (c === "EM") return [2003, 2005];
  if (c === "M1L") return [2025, 2026];
  if (c === "CLF") return [2023, 2024];
  if (/^SV/.test(c)) return [2023, 2026];
  // --- 2026-06 recall batch: era-table gaps found by the post-run audit. ---
  // Each window's basis is the canonical_cards catalog (language='JP'),
  // queried read-only 2026-06-12, cross-checked against the stored search
  // JSONL's product setLongNames — NOT external release calendars, because
  // scoreMatch compares the window against canonical.year, so the window
  // must follow the catalog's year convention.
  // neo1..neo4 + neo-P + neoP2 + neoI: "Gold, Silver, to a New World..."
  // (2000), "Crossing the Ruins..." (2000), "Awakening Legends" (2000),
  // "Darkness, and to Light..." (2001); Premium Files 1999-2000.
  if (additions && /^NEO/.test(c)) return [1999, 2001];
  // PRMF-1/2/3 = Pokemon Card neo "Premium File 1/2/3" → canonical
  // "Neo Premium File 1" (1999), "...2"/"...3" (2000).
  if (additions && /^PRMF/.test(c)) return [1999, 2000];
  // VS = Half Deck "Leaders' Pokemon ..." → canonical "Pokémon VS" (2001).
  // (One outlier product: ADV "Movie Release Commemorative VS Pack" 2003 —
  // inside the scorer's ±3yr slack, so a dedicated entry isn't needed.)
  if (additions && c === "VS") return [2001, 2001];
  // web = "Pokemon Card Web" → canonical "Pokémon Web" (2001).
  if (additions && c === "WEB") return [2001, 2001];
  // SC = Concept Pack "Shiny Collection" → canonical "Shiny Collection"
  // says 2013 (real JP release was Dec 2011; window spans both so the
  // catalog convention and the release year both land era-match).
  // NOTE: exact-match rules; "SCR" (EN Stellar Crown) must NOT hit these.
  if (additions && c === "SC") return [2011, 2013];
  // SC2 = Sword & Shield "VMAX Battle Triple Starter Set" (2020-2021 S-era).
  if (additions && /^SC\d/.test(c)) return [2020, 2022];
  // CP1..CP6 = XY-era Concept Packs → canonical years: "Magma Gang VS Aqua
  // Gang: Double Crisis" 2015 (CP1), "Legendary Shine Collection" 2015
  // (CP2), "PokéKyun Collection" 2016 (CP3), "Premium Champion Pack" 2016
  // (CP4), "Mythical & Legendary Dream Shine Collection" 2016 (CP5),
  // "Expansion Pack 20th Anniversary" 2016 (CP6).
  if (additions && /^CP\d/.test(c)) return [2015, 2016];
  // --- end 2026-06 recall batch (S-block) ---
  if (/^S\d/.test(c)) return [2020, 2022];
  if (/^30TH-P/.test(c)) return [2026, 2026];
  if (/^SM/.test(c)) return [2017, 2019];
  if (/^XY/.test(c)) return [2013, 2016];
  if (/^BW/.test(c)) return [2010, 2013];
  if (/^DP/.test(c)) return [2007, 2010];
  if (/^HG/.test(c) || /^SS/.test(c)) return [2010, 2011];
  if (/^ADV/.test(c) || /^PCG/.test(c)) return [2003, 2007];
  if (/^L[\d-]/.test(c) || /^LL/.test(c)) return [2010, 2011];
  if (/^PT/.test(c)) return [2008, 2010];
  if (/^S-P/.test(c)) return [2020, 2023];
  if (/^SV-P/.test(c)) return [2023, 2026];
  if (/^SM-P/.test(c)) return [2017, 2019];
  if (/^XY-P/.test(c)) return [2013, 2016];
  if (/^BW-P/.test(c)) return [2010, 2013];
  if (/^DP-P/.test(c) || /^DPB-P/.test(c)) return [2007, 2010];
  if (/^HG-P/.test(c) || /^SS-P/.test(c)) return [2010, 2011];
  if (/^PCG-P/.test(c) || /^ADV-P/.test(c)) return [2003, 2007];
  if (/^L-P/.test(c)) return [2010, 2011];
  if (/^PPP/.test(c)) return [2007, 2010];
  if (/^MEP/.test(c)) return [2024, 2026];
  // --- 2026-06 recall batch (M-block). Order matters: the specific rules
  // below must precede the legacy /^M[123]/ catch-all. ---
  // M23 / M24 = SV-era McDonald's promos: "McDonald's Match Battle 2023"
  // (2023) and "Mcdonald's 2025 Dragon Discovery" (2025), per product
  // setLongNames in the stored JSONL. Without this rule they'd fall into
  // the Mega-era window via /^M[123]/ (harmless today only because of the
  // ±3yr slack).
  if (additions && /^M2\d$/.test(c)) return [2023, 2025];
  // MC / MP1 = Start Deck 100 "Battle Collection" (+ "Coro Ciao Ver."),
  // M-P = MEGA "Promotional Card". The compilation set itself isn't in the
  // canonical catalog; window from the Mega-era product family it reprints
  // into ("ex" + "AR Style" cards, gym-leader Trainer's Pokemon — canonical
  // "Hot Air Arena" 2025) and sibling codes M1L..M4 (2025-2026).
  if (additions && (c === "MC" || c === "MP1" || c === "M-P")) return [2025, 2026];
  // Bare M = Random Pack 2009 "Pokemon Arceus" movie commemoration (2009),
  // per product setLongName in the stored JSONL. Must not inherit Mega-era.
  if (additions && c === "M") return [2009, 2009];
  if (/^M[123]/.test(c)) return [2024, 2026];
  // M4+ = Mega-era expansions → canonical "Ninja Spinner" (M4) is 2026;
  // window matches the M1L precedent for the era.
  if (additions && /^M\d/.test(c)) return [2025, 2026];
  // --- end 2026-06 recall batch (M-block) ---
  if (/^SMP/.test(c)) return [2017, 2019];
  if (/^TG/.test(c)) return [2020, 2022];
  return null;
}

// =============================================================================
// Name + number normalization (L2/L3 recall fixes, 2026-06)
// =============================================================================
/**
 * Variant suffix tokens that may legitimately differ between PopAlpha's
 * canonical_name and Snkrdunk's product name FOR THE SAME PHYSICAL CARD:
 *   - "ex"           canonical "Wailord ex" vs product "Wailord"
 *   - "star"         canonical "Latios ☆" (☆ → star) vs product "Latios Star"
 *   - "delta"/"species"  canonical "Mightyena δ" (δ → delta) vs product
 *                    "Mightyena Delta Species"
 *   - "break"        canonical "Florges BREAK" vs product "Florges"
 * Deliberately NOT included: dark/light/shining/mega/radiant/gx/v/vmax —
 * those denote DIFFERENT cards when present on one side only ("Dark
 * Charizard" ≠ "Charizard"), and the modern mechanics (GX/V/VMAX) are
 * never omitted by either side in practice.
 */
const VARIANT_NAME_TOKENS = new Set(["ex", "star", "delta", "species", "break"]);

/**
 * Trailing rarity tokens Snkrdunk appends to product names ("Golem ex RR",
 * "Latias EX SR", "Florges R", "Radiant Charizard K"). Stripped from the
 * PRODUCT side only, and only from the END of the name, before the
 * normalized comparison. Single-letter rarities (R/C/U/P/K) are skipped
 * for Unown — its A–Z letter IS the card identity, not a rarity.
 */
const RARITY_SUFFIX_TOKENS = new Set([
  "c", "u", "r", "rr", "rrr", "sr", "ssr", "hr", "ur", "pr", "p",
  "ir", "ar", "sar", "chr", "csr", "k", "tr", "gr",
]);

/**
 * Normalize a card name to comparable tokens:
 *   - lowercase, NFKD + diacritics stripped ("Flabébé" → "flabebe")
 *   - ☆/★ → "star", δ → "delta", ＆/" and " → "&" (tag-team marker)
 *   - hyphens → spaces ("Shaymin-EX" → "shaymin ex"), punctuation dropped
 *   - optional trailing-rarity strip (product side)
 * Exported for the smoke harness.
 */
export function normalizeNameTokens(name, opts = {}) {
  if (!name) return [];
  let s = String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[☆★]/g, " star ")
    .replace(/δ/g, " delta ")
    .replace(/＆/g, " & ")
    .replace(/[-–—]/g, " ")
    .replace(/[^a-z0-9&\s]/g, " ");
  s = s.replace(/\band\b/g, " & "); // canonical tag teams use "and" where Snkrdunk uses "&"
  let toks = s.split(/\s+/).filter(Boolean);
  if (opts.stripRarity) {
    const isUnown = toks[0] === "unown";
    while (toks.length > 1) {
      const last = toks[toks.length - 1];
      if (!RARITY_SUFFIX_TOKENS.has(last)) break;
      if (isUnown && last.length === 1) break;
      toks = toks.slice(0, -1);
    }
  }
  return toks;
}

/**
 * True when `longer` starts with all of `shorter`'s tokens and every
 * leftover token is a known variant suffix. Prefix (not subset) semantics:
 * "MEGA Latias ex" does NOT match "Latias" because the residue is at the
 * front, and "Latias & Latios" never reaches here against "Latias" (the
 * tag-team guard fails the pair first).
 */
function tokensMatchWithVariantResidue(shorter, longer) {
  if (shorter.length === 0 || longer.length <= shorter.length) return false;
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i] !== longer[i]) return false;
  }
  return longer.slice(shorter.length).every((t) => VARIANT_NAME_TOKENS.has(t));
}

/**
 * Expand a card number into comparable keys (L3 vintage formats):
 *   - "No.009"      → ["9"]              (vintage "No." prefix stripped)
 *   - "074-075/080" → ["74-75","74","75"] (two-part LEGEND numbers match
 *                                          either half or the joined form)
 *   - "037/050"     → ["37"]             (denominator dropped, zeros stripped)
 * Exported for the smoke harness.
 */
export function normalizeNumKeys(s) {
  if (s == null) return [];
  let v = String(s).trim().toLowerCase();
  v = v.replace(/^no\.?\s*/, "");
  v = v.split("/")[0].trim();
  if (!v) return [];
  const stripZeros = (x) => x.replace(/^0+(?=\d)/, "");
  const parts = v.split("-").map((p) => stripZeros(p.trim())).filter(Boolean);
  if (parts.length === 2 && parts.every((p) => /^\d+$/.test(p))) {
    return [parts.join("-"), parts[0], parts[1]];
  }
  return [stripZeros(v)];
}

/**
 * Score a Snkrdunk search result against a canonical card.
 *
 * Signals (positive):
 *   +0.30  Pokemon name token matches (canonical_name appears in parsed.pokemonName)
 *   +0.30  name match after symmetric normalization (hyphens/case/diacritics/
 *          ☆/δ canonicalized; product-side trailing rarity stripped)
 *   +0.25  name match with variant-suffix residue in EITHER direction
 *          ("Wailord ex" ↔ "Wailord") — deliberately BELOW the exact/prefix
 *          credit so a fuzzier match never outranks today's exact match
 *   +0.30  card_number matches (canonical card_number == parsed cardNumber,
 *          via normalizeNumKeys: zero-strip, "No." prefix, LEGEND two-part)
 *   +0.20  Set hint matches (distinctive set name fragment appears in parsed.setLongName)
 *   +0.15  Era-match: canonical.year falls within the Snkrdunk setCode's era window
 *
 * Signals (negative):
 *   -0.20  parsed.pokemonName starts with a DIFFERENT Pokemon name
 *          (catches "Marnie [SC2 020/021](...VMAX Battle Triple Starter
 *          Set...Charizard...)" — the set name mentions Charizard but
 *          the card is Marnie. Tracking the actual card name is critical.)
 *   -0.20  multi-Pokemon mismatch: exactly one side is a tag team / duo
 *          ("&"/"＆"/" and "). The 2026-05 Latias incident: a $564
 *          "Latias & Latios GX" was mapped onto plain "Latias" because
 *          "latias & latios gx".startsWith("latias ") passed the prefix
 *          test and the number coincided. Tag-team-vs-single now earns NO
 *          name credit AND this penalty, making the pair strictly harder
 *          to match than before.
 *   -0.30  Era-mismatch: canonical.year falls outside the Snkrdunk setCode's
 *          era window by more than 3 years (e.g., 1996 canonical mapped to a
 *          2023 reprint product). Generalized post-PR #71 audit from the
 *          previous narrow "vintage canonical + modern setCode" rule.
 *
 * Clamped to [0, 1]. Threshold MIN_MATCH_SCORE = 0.55 = at least the
 * name + one strong disambiguator (number or set).
 *
 * Returns { score, reasons, setTokenHits } — setTokenHits feeds the
 * sister-set guard in classifyBest (see AMBIGUOUS_SET_TOKENS).
 *
 * opts.features lets the offline re-scorer toggle each 2026-06 fix to
 * attribute flips: { nameNorm, numForms, eraAdditions } — all default true.
 */
export function scoreMatch(candidate, card, opts = {}) {
  const features = { nameNorm: true, numForms: true, eraAdditions: true, ...(opts.features ?? {}) };
  const parsed = candidate.parsed;
  const reasons = [];
  let score = 0;
  if (!parsed) {
    return { score: 0, reasons: ["unparseable-name"], setTokenHits: [] };
  }
  const cname = (card.canonical_name ?? "").trim().toLowerCase();
  const cnumber = (card.card_number ?? "").trim();
  const cset = (card.set_name ?? "").trim().toLowerCase();

  // Pokemon name
  const pname = (parsed.pokemonName ?? "").toLowerCase();
  let multiPokemonMismatch = false;
  if (cname && pname && features.nameNorm) {
    const cTok = normalizeNameTokens(cname);
    const pTok = normalizeNameTokens(pname, { stripRarity: true });
    const cMulti = cTok.includes("&");
    const pMulti = pTok.includes("&");
    if (cMulti !== pMulti) {
      // Tag team on one side only — never the same card. No name credit;
      // the penalty below fires instead. (Latias incident guard.)
      multiPokemonMismatch = true;
    } else if (pname === cname) {
      score += 0.30;
      reasons.push("+0.30 name-exact");
    } else if (pname.startsWith(cname + " ")) {
      // Snkrdunk often appends a rarity suffix (e.g. "Charizard VMAX HR")
      score += 0.30;
      reasons.push("+0.30 name-prefix");
    } else if (pname.includes(cname)) {
      // Looser containment — e.g. "Radiant Charizard K" contains "charizard"
      score += 0.20;
      reasons.push("+0.20 name-contained");
    } else if (cTok.length > 0 && cTok.join(" ") === pTok.join(" ")) {
      // Same name modulo hyphens/case/diacritics/symbols/rarity suffix:
      // "Latias-EX" ↔ "Latias EX R", "Shaymin-EX" ↔ "Shaymin EX SR".
      score += 0.30;
      reasons.push("+0.30 name-normalized");
    } else if (
      tokensMatchWithVariantResidue(cTok, pTok) ||
      tokensMatchWithVariantResidue(pTok, cTok)
    ) {
      // Same base name, variant suffix present on one side only:
      // "Wailord ex" ↔ "Wailord", "Mightyena δ" ↔ "Mightyena Delta Species".
      // Capped below exact/prefix per the L2 recall-fix spec.
      score += 0.25;
      reasons.push("+0.25 name-variant-normalized");
    }
  } else if (cname && pname) {
    // Legacy name rules (features.nameNorm === false — re-score attribution only).
    if (pname === cname) {
      score += 0.30;
      reasons.push("+0.30 name-exact");
    } else if (pname.startsWith(cname + " ")) {
      score += 0.30;
      reasons.push("+0.30 name-prefix");
    } else if (pname.includes(cname)) {
      score += 0.20;
      reasons.push("+0.20 name-contained");
    }
  }

  // Card number
  //
  // Normalize before comparing because PopAlpha and Snkrdunk use
  // different conventions:
  //   PopAlpha: "37", "104", "211" (no leading zeros)
  //   Snkrdunk: "037/050", "104", "074/073" (zero-padded numerator,
  //             optional denominator), "No.009" (vintage "No." prefix),
  //             "074-075/080" (two-part LEGEND numbers)
  // Normalization: normalizeNumKeys above — match on any shared key.
  const legacyNormalizeNum = (s) => s.split("/")[0].replace(/^0+(?=\d)/, "").trim();
  const pnumber = (parsed.cardNumber ?? "").trim();
  if (cnumber && pnumber) {
    if (pnumber === cnumber) {
      score += 0.30;
      reasons.push("+0.30 number-exact");
    } else if (features.numForms) {
      const ckeys = normalizeNumKeys(cnumber);
      const pkeys = normalizeNumKeys(pnumber);
      const hit = ckeys.find((k) => pkeys.includes(k));
      if (hit) {
        // "37" matches "037" / "037/050"; "9" matches "No.009";
        // "74", "75" and "74-75" all match "074-075/080" → same card
        score += 0.30;
        reasons.push(`+0.30 number-normalized (${hit})`);
      }
    } else {
      // Legacy comparator (features.numForms === false — re-score attribution only).
      const cnumNorm = legacyNormalizeNum(cnumber);
      const pnumNorm = legacyNormalizeNum(pnumber);
      if (cnumNorm && pnumNorm && cnumNorm === pnumNorm) {
        score += 0.30;
        reasons.push(`+0.30 number-normalized (${cnumNorm})`);
      }
    }
  }

  // Set hint
  const psetLong = (parsed.setLongName ?? "").toLowerCase();
  const psetCode = (parsed.setCode ?? "").toLowerCase();
  let setTokenHits = [];
  if (cset && (psetLong || psetCode)) {
    // Tokenize set name into significant words (>3 chars), check overlap.
    // Filter out GENERIC tokens that appear in almost every Pokemon
    // parenthetical — they don't constitute distinctive set evidence.
    // Codex P1 on PR #54 (post-fix): "Pokemon" / "Promo" / "Cards" /
    // "Pack" / "Expansion" overlap on most candidates, so matching on
    // them alone shouldn't bypass the needs-review gate.
    const SET_TOKEN_STOPWORDS = new Set([
      "pokemon", "pokémon",
      "promo", "promos", "promotional",
      "cards", "card",
      "pack", "expansion", "enhanced",
      "deck", "starter",
      "single", "singles",
      // Expanded post-PR #71 era audit: these tokens leak across vintage
      // parentheticals ("Pokemon Game", "Pokemon Pocket Monsters", "Holon
      // Phantoms", "Classic Collection") and grant set-token credit to
      // wildly wrong reprints. Stripping them forces the matcher to lean
      // on actual distinctive set names (e.g., "Jungle", "Fossil",
      // "Aquapolis", "Skyridge") + the era/number gates below.
      "game", "games",
      "classic", "classics",
      "set", "sets",
      "pocket", "monster", "monsters",
      "holon", "series", "edition",
    ]);
    const csetTokens = cset
      .split(/\s+/)
      .map((t) => t.toLowerCase().replace(/[^a-zà-üœ0-9]/g, ""))
      .filter((t) => t.length >= 4 && !SET_TOKEN_STOPWORDS.has(t));
    setTokenHits = csetTokens.filter((t) => psetLong.includes(t) || psetCode.includes(t));
    if (setTokenHits.length > 0) {
      const bump = Math.min(0.20, 0.10 * setTokenHits.length);
      score += bump;
      reasons.push(`+${bump.toFixed(2)} set-tokens (${setTokenHits.join(",")})`);
    }
  }

  // Negative: different Pokemon name in the candidate's pokemonName
  // We only fire this if we DIDN'T already match positively on name.
  if (!reasons.some((r) => r.includes("name-"))) {
    if (multiPokemonMismatch) {
      // Tag team vs single Pokemon (or vice versa) — wrong card even
      // though the single name is a substring of the tag-team name, so
      // the different-pokemon check below would NOT fire on its own.
      score -= 0.20;
      reasons.push("-0.20 multi-pokemon-mismatch");
    } else if (pname && cname && !pname.includes(cname)) {
      // Candidate parsed a Pokemon name and it's not ours → likely wrong card
      score -= 0.20;
      reasons.push("-0.20 different-pokemon-name");
    }
  }

  // Era scoring.
  //
  // Generalized post-PR #71 era audit. The previous rule only fired on
  // vintage→modern mismatches (e.g., 1995 Topsun #100 Voltorb wrongly
  // matched against SV2a 100/165 Voltorb). That left the inverse case
  // uncovered: a 2017 canonical occasionally got pulled onto a 2010 L1-S
  // Legend reprint because name+number both matched. The expanded rule:
  //   +0.15 if canonical.year falls inside the Snkrdunk setCode's era
  //         window (with a ±3yr slack for boundary cases like Legendary
  //         Treasures reprints).
  //   -0.30 if canonical.year falls outside the era window by more
  //         than 3yr.
  // No-op when either side is missing (setCodeEra returns null for
  // unmapped codes, and canonical.year can be NULL for sealed-product
  // catalog rows).
  const cyear = typeof card.year === "number" ? card.year : null;
  const era = psetCode
    ? setCodeEra(psetCode.toUpperCase(), { additions: features.eraAdditions })
    : null;
  if (cyear && era) {
    const [yMin, yMax] = era;
    if (cyear >= yMin - 3 && cyear <= yMax + 3) {
      score += 0.15;
      reasons.push(`+0.15 era-match (${cyear} in [${yMin}-${yMax}] for ${psetCode})`);
    } else {
      score -= 0.30;
      reasons.push(`-0.30 era-mismatch (canonical ${cyear} vs setCode ${psetCode} era [${yMin}-${yMax}])`);
    }
  }

  return { score: Math.max(0, Math.min(1, score)), reasons, setTokenHits };
}

// =============================================================================
// Status classification (shared by the live matcher + offline re-scorer)
// =============================================================================
/**
 * Sister-set guard (2026-06 recall batch).
 *
 * JP sets ship in paired "sister" variants and PopAlpha/Snkrdunk sometimes
 * translate the same JP set differently — the premise lib/jp/set-pair-map.mjs
 * builds its EN↔JP pairing rows around. Canonical example: XY8 青い衝撃 is
 * PopAlpha set_name "Blue Shock" but Snkrdunk's parenthetical says
 * "Blue Impact"; the only overlapping token is "blue", which ALSO matches
 * "Blue Sky Stream" (2021) and "Clash of the Blue Sky" (2004). A single hit
 * on such a token is NOT distinctive set evidence, so it must not
 * auto-promote a row to MATCHED (Florges BREAK case from the recall audit).
 *
 * AMBIGUOUS_SET_TOKENS = set-name tokens that appear (by the scorer's own
 * substring test) in ≥2 distinct JP set_names in canonical_cards.
 * Derived read-only from prod on 2026-06-12 (212 distinct JP set names;
 * 74/286 tokens ambiguous) with the exact tokenizer scoreMatch uses.
 * Regenerate after major JP catalog expansions:
 *   tokenize every distinct lower(set_name) (length>=4, minus
 *   SET_TOKEN_STOPWORDS) and keep tokens contained in ≥2 set names.
 */
export const AMBIGUOUS_SET_TOKENS = new Set([
  "anniversary", "aqua", "awakening", "battle", "beat", "black", "blaze",
  "blue", "bolt", "boost", "break", "burst", "champion", "clash",
  "collection", "dark", "darkness", "double", "dragon", "dream", "ends",
  "fight", "fighter", "file", "flare", "flash", "force", "from", "gang",
  "gold", "heavens", "heroes", "legend", "legendary", "legends", "light",
  "lost", "machine", "magma", "master", "mega", "miracle", "moon",
  "mysterious", "night", "phantom", "premium", "rage", "rising", "rocket",
  "ruler", "scarlet", "shield", "shine", "shining", "shiny", "silver",
  "space", "split", "star", "storm", "strike", "super", "sword", "team",
  "thunder", "time", "ultra", "vending", "violet", "vmax", "white", "wild",
  "world",
]);

/**
 * Distinctive set evidence = at least two token hits (two simultaneous
 * coincidences across different sets are not observed in practice), or a
 * single hit on a token unique to one JP set ("shock", "aquapolis", ...).
 */
export function hasDistinctiveSetSignal(setTokenHits) {
  const hits = Array.isArray(setTokenHits) ? setTokenHits : [];
  if (hits.length === 0) return false;
  if (hits.length >= 2) return true;
  return !AMBIGUOUS_SET_TOKENS.has(hits[0]);
}

/**
 * Three-tier status for downstream Step C:
 *   - "matched"       — score >= threshold AND distinctive set evidence
 *                       (see hasDistinctiveSetSignal). Safe to auto-import.
 *   - "needs-review"  — score >= threshold but set evidence is absent OR
 *                       a single ambiguous token. Codex P1 on PR #54: two
 *                       cards can share canonical_name + number across
 *                       different sets, so name + number alone is not
 *                       enough to auto-accept; the 2026-06 sister-set
 *                       guard extends the same logic to single ambiguous
 *                       set tokens ("blue"). Step C requires operator
 *                       confirmation for these.
 *   - "low-confidence" — score < threshold.
 */
export function classifyBest(best) {
  if (!best || typeof best.score !== "number" || best.score < MIN_MATCH_SCORE) {
    return "low-confidence";
  }
  return hasDistinctiveSetSignal(best.setTokenHits) ? "matched" : "needs-review";
}

async function searchSnkrdunk(keyword, { perPage = DEFAULT_PER_PAGE, page = 1 } = {}) {
  const url = `https://snkrdunk.com/en/v1/search?keyword=${encodeURIComponent(keyword)}&type=streetwear&page=${page}&perPage=${perPage}`;
  const referer = `https://snkrdunk.com/en/search/result?keyword=${encodeURIComponent(keyword)}`;
  return fetchJson(url, { referer });
}

async function matchOneCanonical(card) {
  const keyword = buildQuery(card);
  if (!keyword) {
    return { canonical_slug: card.slug, status: "no-query", reason: "no canonical_name" };
  }

  let res;
  try {
    res = await searchSnkrdunk(keyword);
  } catch (err) {
    if (err instanceof SnkrdunkPushbackError) throw err;
    return { canonical_slug: card.slug, status: "search-failed", reason: err.message };
  }

  const rawResults = Array.isArray(res?.streetwears) ? res.streetwears : [];
  // Only consider trading-card results (Snkrdunk tags these)
  const tcResults = rawResults.filter((r) => r?.isTradingCard === true);
  if (tcResults.length === 0) {
    return {
      canonical_slug: card.slug,
      query: keyword,
      streetwearCount: res?.streetwearCount ?? 0,
      status: "no-tc-results",
    };
  }

  // Parse each result + score
  const candidates = tcResults.map((r) => {
    const parsed = parseSnkrdunkProductName(r.name);
    const { score, reasons, setTokenHits } = scoreMatch({ parsed }, card);
    return {
      snkrdunk_id: r.id,
      snkrdunk_product_code: `SW---${r.id}`,
      name: r.name,
      parsed,
      score,
      reasons,
      setTokenHits,
      minPriceUsd: r.minPrice ?? null,
      listingCount: r.listingCount ?? null,
    };
  });
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];

  // Status logic shared with the offline re-scorer — see classifyBest
  // (matched / needs-review / low-confidence, with the sister-set guard
  // gating single-ambiguous-token set evidence).
  const status = classifyBest(best);
  const accepted = status === "matched" || status === "needs-review" ? best : null;

  return {
    canonical_slug: card.slug,
    query: keyword,
    streetwearCount: res?.streetwearCount ?? 0,
    candidatesReturned: rawResults.length,
    candidatesAfterTcFilter: tcResults.length,
    candidates: candidates.slice(0, 5), // top 5 for debug
    best: accepted,
    bestScore: best?.score ?? 0,
    status,
  };
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    slug: null,
    allMatchedJp: false,
    offset: 0,
    limit: null,
    output: DEFAULT_OUTPUT,
    delayMs: DEFAULT_DELAY_MS,
    concurrency: DEFAULT_CONCURRENCY,
    json: false,
  };
  for (const a of args) {
    if (a.startsWith("--slug=")) opts.slug = a.slice("--slug=".length);
    else if (a === "--all-matched-jp") opts.allMatchedJp = true;
    else if (a.startsWith("--offset=")) opts.offset = Math.max(0, Number.parseInt(a.slice("--offset=".length), 10) || 0);
    else if (a.startsWith("--limit=")) opts.limit = Math.max(1, Number.parseInt(a.slice("--limit=".length), 10) || 1);
    else if (a.startsWith("--output=")) opts.output = a.slice("--output=".length);
    else if (a.startsWith("--delay=")) opts.delayMs = Math.max(100, Number.parseInt(a.slice("--delay=".length), 10) || 100);
    else if (a.startsWith("--concurrency=")) opts.concurrency = Math.max(1, Math.min(3, Number.parseInt(a.slice("--concurrency=".length), 10) || 1));
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

async function loadCanonicalCards(supabase, opts) {
  if (opts.slug) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, canonical_name_native, set_name, set_name_native, card_number, year, language")
      .eq("slug", opts.slug)
      .limit(1);
    if (error) throw new Error(error.message);
    return data ?? [];
  }
  if (!opts.allMatchedJp) {
    throw new Error("Specify --slug=X or --all-matched-jp");
  }
  // Page through JP canonical_cards with at least one MATCHED provider_card_map row
  const PAGE = 1000;
  const rows = [];
  const baseSelect = "slug, canonical_name, canonical_name_native, set_name, set_name_native, card_number, year, language";
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select(`${baseSelect}, provider_card_map!inner(mapping_status)`)
      .eq("language", "JP")
      .eq("provider_card_map.mapping_status", "MATCHED")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  // Dedupe by slug
  const seen = new Set();
  return rows.filter((r) => {
    if (seen.has(r.slug)) return false;
    seen.add(r.slug);
    return true;
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const allCards = await loadCanonicalCards(supabase, opts);
  if (allCards.length === 0) {
    console.error("[match-snkrdunk] no canonical cards matched the input filters");
    process.exit(1);
  }
  console.log(`[match-snkrdunk] loaded ${allCards.length} canonical_card(s)`);

  // Apply offset/limit
  const start = Math.min(opts.offset, allCards.length);
  const end = opts.limit != null ? Math.min(start + opts.limit, allCards.length) : allCards.length;
  const range = allCards.slice(start, end);
  console.log(`[match-snkrdunk] range: offset ${start}..${end} (${range.length} card(s))`);

  // Resume: skip slugs already in the output JSONL
  const outputPath = resolve(opts.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  const alreadyDone = new Set();
  if (existsSync(outputPath)) {
    for (const line of readFileSync(outputPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.canonical_slug) alreadyDone.add(obj.canonical_slug);
      } catch {/* skip */}
    }
    console.log(`[match-snkrdunk] resume: ${alreadyDone.size} slug(s) already in ${outputPath}`);
  }
  const todo = range.filter((c) => !alreadyDone.has(c.slug));
  console.log(`[match-snkrdunk] todo: ${todo.length} slug(s) after resume filter`);
  if (todo.length === 0) {
    console.log("[match-snkrdunk] nothing to do — exiting");
    return;
  }

  const startedAt = Date.now();
  let matched = 0;
  let needsReview = 0;
  let lowConfidence = 0;
  let noResults = 0;
  let errors = 0;
  let halted = false;
  let haltReason = null;

  outer:
  for (let i = 0; i < todo.length; i += opts.concurrency) {
    const batch = todo.slice(i, i + opts.concurrency);
    let results;
    try {
      results = await Promise.all(batch.map(async (card) => {
        try { return await matchOneCanonical(card); }
        catch (err) {
          if (err instanceof SnkrdunkPushbackError) throw err;
          return { canonical_slug: card.slug, status: "exception", reason: err.message };
        }
      }));
    } catch (err) {
      if (err instanceof SnkrdunkPushbackError) {
        halted = true;
        haltReason = err.message;
        console.error(`[match-snkrdunk] AUTO-HALT: ${haltReason}`);
        console.error(`[match-snkrdunk] Re-run is idempotent — resume from output JSONL.`);
        break outer;
      }
      throw err;
    }

    const lines = results.map((r) => JSON.stringify(r));
    appendFileSync(outputPath, lines.join("\n") + "\n");

    for (const r of results) {
      if (r.status === "matched") matched += 1;
      else if (r.status === "needs-review") needsReview += 1;
      else if (r.status === "low-confidence") lowConfidence += 1;
      else if (r.status === "no-tc-results" || r.status === "no-query") noResults += 1;
      else errors += 1;
    }

    const processed = i + batch.length;
    if (processed % 50 === 0 || processed === todo.length) {
      const sec = (Date.now() - startedAt) / 1000;
      const rate = processed / Math.max(0.1, sec);
      const remaining = todo.length - processed;
      const etaMin = (remaining / Math.max(0.001, rate)) / 60;
      console.log(`[match-snkrdunk] ${processed}/${todo.length}  matched=${matched} needs-review=${needsReview} low-conf=${lowConfidence} no-res=${noResults} err=${errors}  ${rate.toFixed(2)} req/s  ETA ${etaMin.toFixed(1)}min`);
    }

    if (i + opts.concurrency < todo.length) {
      await sleep(opts.delayMs + Math.random() * DEFAULT_JITTER_MS);
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`[match-snkrdunk] DONE in ${elapsedSec}s`);
  console.log(`[match-snkrdunk] matched=${matched} needs-review=${needsReview} low-conf=${lowConfidence} no-results=${noResults} errors=${errors}`);
  console.log(`[match-snkrdunk] output: ${outputPath}`);
  if (halted) {
    // Exit non-zero so operator wrappers / CI jobs don't treat a
    // partial run as a successful complete one. Matches the exit-2
    // convention used by run-yahoo-jp-pipeline.mjs and
    // run-snkrdunk-pipeline.mjs. Codex P2 on PR #54.
    console.error(`[match-snkrdunk] HALTED: ${haltReason}`);
    process.exit(2);
  }
}

// Only auto-run when invoked as a CLI; allow imports for testing.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[match-snkrdunk] FATAL:", err);
    process.exit(1);
  });
}
