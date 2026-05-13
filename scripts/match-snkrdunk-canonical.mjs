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
const MIN_MATCH_SCORE = 0.55; // tuned: top-match needs strong name + (set OR number) signal
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
 * Score a Snkrdunk search result against a canonical card.
 *
 * Signals (positive):
 *   +0.30  Pokemon name token matches (canonical_name appears in parsed.pokemonName)
 *   +0.30  card_number matches (canonical card_number == parsed cardNumber, or
 *          either is a prefix of the other for fractional forms like "074/073")
 *   +0.20  Set hint matches (set name fragment appears in parsed.setLongName)
 *
 * Signals (negative):
 *   -0.20  parsed.pokemonName starts with a DIFFERENT Pokemon name
 *          (catches "Marnie [SC2 020/021](...VMAX Battle Triple Starter
 *          Set...Charizard...)" — the set name mentions Charizard but
 *          the card is Marnie. Tracking the actual card name is critical.)
 *
 * Clamped to [0, 1]. Threshold MIN_MATCH_SCORE = 0.55 = at least the
 * name + one strong disambiguator (number or set).
 */
function scoreMatch(candidate, card) {
  const parsed = candidate.parsed;
  const reasons = [];
  let score = 0;
  if (!parsed) {
    return { score: 0, reasons: ["unparseable-name"] };
  }
  const cname = (card.canonical_name ?? "").trim().toLowerCase();
  const cnumber = (card.card_number ?? "").trim();
  const cset = (card.set_name ?? "").trim().toLowerCase();

  // Pokemon name
  const pname = (parsed.pokemonName ?? "").toLowerCase();
  if (cname && pname) {
    if (pname === cname) {
      score += 0.30;
      reasons.push("+0.30 name-exact");
    } else if (pname.startsWith(cname + " ") || pname === cname) {
      // Snkrdunk often appends a rarity suffix (e.g. "Charizard VMAX HR")
      score += 0.30;
      reasons.push("+0.30 name-prefix");
    } else if (pname.includes(cname)) {
      // Looser containment — e.g. "Radiant Charizard K" contains "charizard"
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
  //             optional denominator)
  // Normalization: strip leading zeros from numerator, drop denominator
  // for comparison purposes.
  const normalizeNum = (s) => s.split("/")[0].replace(/^0+(?=\d)/, "").trim();
  const pnumber = (parsed.cardNumber ?? "").trim();
  if (cnumber && pnumber) {
    const cnumNorm = normalizeNum(cnumber);
    const pnumNorm = normalizeNum(pnumber);
    if (pnumber === cnumber) {
      score += 0.30;
      reasons.push("+0.30 number-exact");
    } else if (cnumNorm && pnumNorm && cnumNorm === pnumNorm) {
      // "37" matches "037" / "037/050" → same card
      score += 0.30;
      reasons.push(`+0.30 number-normalized (${cnumNorm})`);
    }
  }

  // Set hint
  const psetLong = (parsed.setLongName ?? "").toLowerCase();
  const psetCode = (parsed.setCode ?? "").toLowerCase();
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
    ]);
    const csetTokens = cset
      .split(/\s+/)
      .map((t) => t.toLowerCase().replace(/[^a-zà-üœ0-9]/g, ""))
      .filter((t) => t.length >= 4 && !SET_TOKEN_STOPWORDS.has(t));
    const hits = csetTokens.filter((t) => psetLong.includes(t) || psetCode.includes(t));
    if (hits.length > 0) {
      const bump = Math.min(0.20, 0.10 * hits.length);
      score += bump;
      reasons.push(`+${bump.toFixed(2)} set-tokens (${hits.join(",")})`);
    }
  }

  // Negative: different Pokemon name in the candidate's pokemonName
  // We only fire this if we DIDN'T already match positively on name.
  if (!reasons.some((r) => r.includes("name-"))) {
    if (pname && cname && !pname.includes(cname)) {
      // Candidate parsed a Pokemon name and it's not ours → likely wrong card
      score -= 0.20;
      reasons.push("-0.20 different-pokemon-name");
    }
  }

  // Negative: era mismatch.
  // Vintage canonical_cards (year < 2010) sometimes share card numbers
  // with modern Snkrdunk reprints — e.g., canonical "Topsun #100 Voltorb"
  // (1995) accidentally matches Snkrdunk "Voltorb [SV2a 100/165]"
  // (modern). Number + name both match, but the era doesn't. Snkrdunk's
  // modern setCodes always start with "S" + digit (Sword & Shield era,
  // 2020+) or "SV" + digit (Scarlet & Violet era, 2023+). If our
  // canonical card is vintage and the Snkrdunk setCode looks modern,
  // they can't be the same card.
  const cyear = typeof card.year === "number" ? card.year : null;
  if (cyear && cyear < 2010 && psetCode) {
    const looksModern = /^S\d/i.test(psetCode) || /^SV\d/i.test(psetCode);
    if (looksModern) {
      score -= 0.30;
      reasons.push(`-0.30 era-mismatch (vintage canonical ${cyear} vs modern setCode ${psetCode})`);
    }
  }

  return { score: Math.max(0, Math.min(1, score)), reasons };
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
    const { score, reasons } = scoreMatch({ parsed }, card);
    return {
      snkrdunk_id: r.id,
      snkrdunk_product_code: `SW---${r.id}`,
      name: r.name,
      parsed,
      score,
      reasons,
      minPriceUsd: r.minPrice ?? null,
      listingCount: r.listingCount ?? null,
    };
  });
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];

  // Three-tier status for downstream Step C:
  //   - "matched"       — score >= threshold AND has set evidence
  //                       (set-token hit). Safe to auto-import.
  //   - "needs-review"  — score >= threshold but NO set evidence
  //                       (name + number alone). Codex P1 on PR #54:
  //                       two cards can share canonical_name + number
  //                       across different sets, so name + number
  //                       alone is not enough to auto-accept. Step C
  //                       requires operator confirmation for these.
  //   - "low-confidence" — score < threshold.
  const hasSetSignal = best
    ? best.reasons.some((r) => r.startsWith("+") && r.includes("set-tokens"))
    : false;
  let status;
  let accepted = null;
  if (best && best.score >= MIN_MATCH_SCORE) {
    if (hasSetSignal) {
      status = "matched";
      accepted = best;
    } else {
      // No set evidence — cross-set false-positive risk. Surface but
      // gate at Step C.
      status = "needs-review";
      accepted = best;
    }
  } else {
    status = "low-confidence";
  }

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

main().catch((err) => {
  console.error("[match-snkrdunk] FATAL:", err);
  process.exit(1);
});
