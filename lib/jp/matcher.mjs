/**
 * JP listing → canonical_card matcher.
 *
 * Pure functions over (canonicalCard, scrapedListing) → match decision.
 * No DB access here — the orchestrator (scripts/match-yahoo-jp.mjs and
 * eventually lib/backfill/yahoo-jp-orchestrator.ts) handles I/O. This
 * file is meant to be deterministic and testable.
 *
 * Pipeline:
 *   1. buildPrecisionQuery(canonicalCard) → JP search string
 *   2. scoreListing(listing, canonicalCard) → { score, reasons[] }
 *   3. extractGrade(listing) → { company, grade } | { company: null, ... }
 *   4. applyHardExclusions(listings) → listings
 *   5. selectMatched(listings, canonicalCard, opts) → ranked match set
 *
 * Three confidence tiers in v0:
 *   - HIGH (>= 0.80): include in price aggregation, no manual review
 *   - MEDIUM (0.50 – 0.79): include but flag for ratio-watch
 *   - LOW (< 0.50): drop OR route to LLM-tiebreaker (Day 3+)
 */

import {
  POKEMON_NAMES,
  TRAINER_PREFIXES,
  SET_NAMES,
  HARD_EXCLUDE_TOKENS,
  ALL_GLOSSARY_SORTED,
} from "./glossary.mjs";

// =============================================================================
// EN → JP name lookup (reverse of POKEMON_NAMES)
// =============================================================================
// Used when canonical_name_native is missing from DB (pre-backfill, or
// for non-Pokemon proper-noun cards). Built once at module load.
export const EN_TO_JP_POKEMON = (() => {
  const out = {};
  for (const [jp, en] of Object.entries(POKEMON_NAMES)) {
    if (typeof en === "string" && en && !en.startsWith("(")) {
      // Don't overwrite if multiple JP names map to one EN (rare but
      // possible — keep the first to maintain determinism).
      if (!out[en]) out[en] = jp;
    }
  }
  return out;
})();

export const EN_TO_JP_SET = (() => {
  const out = {};
  for (const [jp, en] of Object.entries(SET_NAMES)) {
    // EN often has parenthetical equivalence like "Expansion Pack (= Base Set)"
    // Extract the "= X" part if present, prefer the bare JP name.
    const enSplit = String(en).split(/\s*\(=\s*|\)/).filter(Boolean);
    for (const variant of enSplit) {
      if (variant && !out[variant.trim()]) out[variant.trim()] = jp;
    }
  }
  return out;
})();

// =============================================================================
// Known JP set-name tokens used for "wrong set in title" detection
// =============================================================================
// These are the major JP set names that frequently appear in vintage
// Pokemon search results and confuse the matcher. When the canonical's
// expected set is X but the listing title prominently mentions a
// DIFFERENT set Y from this list, that's a strong signal we're looking
// at a different physical card. Used by scoreListing's negative-signal
// pass.
//
// Priority order matters — longest first so "プレミアムファイル2" is
// detected before "プレミアムファイル". This is the same rationale as
// the glossary's longest-match-first sort.
const KNOWN_JP_SETS = [
  // Modern era — most common confusers when searching vintage names
  "VMAXクライマックス",
  "25th Anniversary Collection",
  "VSTARユニバース",
  "シャイニースターV",
  // Vintage era — Base/Neo/Gym/Promo + their Premium Files
  "プレミアムファイル3",
  "プレミアムファイル2",
  "プレミアムファイル1",
  "リーダーズスタジアム",
  "闇からの挑戦",
  "金、銀、新世界へ",
  "遺跡をこえて",
  "めざめる伝説",
  "闇、そして光へ",
  "ポケモンジャングル",
  "化石の秘密",
  "ロケット団",
  "拡張シート",
  // ADV / e-card era (the "delta species" confusers for vintage Charizard)
  "さいはての攻防",
  "ホロンの幻影",
  "ホロンの研究塔",
  "きせきの結晶",
  "まぼろしの森",
  "金の空、銀の海",
  "天空の覇者",
  "とかれた封印",
  "マグマVSアクア ふたつの野望",
  "ふたつの野望",
  "海からの風",
  "地図にない町",
  "裂けた大地",
  // Modern DP/Pt confusers
  "時空の創造",
  "ギンガの覇道",
  "アルセウス光臨",
  // Generic Base ("拡張パック") deliberately omitted — too short and
  // overlaps with vintage canonical's own set name (拡張パック = Base
  // Set). The numbered "第1弾"/"第4弾" markers stay handled by the
  // era/edition signals.
];

// =============================================================================
// EN trainer/region prefix table — shared between query builder + scorer
// =============================================================================
// Ordered longest-first so "Lt. Surge's" matches before any partial "Surge".
const PREFIX_TABLE = [
  ["Lt. Surge's", "マチスの"],
  ["Team Rocket's", "ロケット団の"],
  ["Erika's", "エリカの"],
  ["Misty's", "カスミの"],
  ["Brock's", "タケシの"],
  ["Blaine's", "カツラの"],
  ["Koga's", "キョウの"],
  ["Giovanni's", "サカキの"],
  ["Sabrina's", "ナツメの"],
  ["Rocket's", "ロケット団の"],
  ["Galarian", "ガラルの"],
  ["Hisuian", "ヒスイの"],
  ["Alolan", "アローラの"],
  ["Paldean", "パルデアの"],
  ["Dark", "わるい"],
  ["Light", "ひかる"],
  ["Shining", "光る"],
];

/**
 * Resolve a (possibly prefixed/suffixed) EN canonical_name to its JP
 * equivalent. Handles trainer prefixes ("Blaine's", "Dark"), region
 * prefixes ("Galarian"), and variant suffixes ("ex", "V", "VMAX"). Used
 * by both the query builder and the listing scorer so the JP name they
 * look for is identical.
 *
 * Returns: { jpName, baseEnName, enPrefix, jpPrefix, variantSuffix } or
 * null if the bare Pokemon name isn't in POKEMON_NAMES.
 */
export function resolveEnToJpName(canonicalEnName) {
  let working = String(canonicalEnName ?? "").trim();
  if (!working) return null;
  let jpPrefix = null;
  let enPrefix = null;
  for (const [en, jp] of PREFIX_TABLE) {
    const re = new RegExp(`^${en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.+)$`, "i");
    const m = working.match(re);
    if (m) {
      enPrefix = en;
      jpPrefix = jp;
      working = m[1].trim();
      break;
    }
  }
  const variantMatch = working.match(/\s+(ex|gx|vmax|vstar|v|lv\.x|EX|GX|V|VMAX|VSTAR)$/i);
  const variantSuffix = variantMatch ? variantMatch[1] : null;
  const baseName = variantMatch ? working.slice(0, variantMatch.index).trim() : working;
  const jp = EN_TO_JP_POKEMON[baseName];
  if (!jp) return null;
  let jpName = jpPrefix ? `${jpPrefix}${jp}` : jp;
  if (variantSuffix) jpName += ` ${variantSuffix}`;
  return { jpName, baseEnName: baseName, enPrefix, jpPrefix, variantSuffix };
}

// =============================================================================
// 1. Query construction
// =============================================================================
/**
 * Build a Yahoo! Auctions JP search query that's narrow enough to return
 * mostly listings of one specific canonical card. Tokens are tuned for
 * recall over precision — the filter step drops false positives, but if
 * we miss true matches at the query layer there's no recovery.
 */
export function buildPrecisionQuery(canonicalCard) {
  const nameNative = canonicalCard.canonical_name_native?.trim();
  const nameEn = canonicalCard.canonical_name?.trim() ?? "";
  const setNative = canonicalCard.set_name_native?.trim();
  const setEn = canonicalCard.set_name?.trim() ?? "";

  // Pokemon name token — JP if available, otherwise glossary lookup with
  // prefix/suffix handling.
  let pokemonToken = nameNative;
  if (!pokemonToken) {
    const resolved = resolveEnToJpName(nameEn);
    if (resolved) pokemonToken = resolved.jpName;
  }

  // Set token — JP if available, otherwise glossary lookup
  let setToken = setNative;
  if (!setToken && setEn) {
    setToken = EN_TO_JP_SET[setEn] ?? null;
  }

  // Era hint based on year (vintage helps disambiguate from modern reprints)
  let eraToken = null;
  if (typeof canonicalCard.year === "number") {
    if (canonicalCard.year >= 1996 && canonicalCard.year <= 2002) eraToken = "旧裏";
    // Don't tag modern era — the set name already disambiguates and
    // adding "新裏" reduces recall for cards listed without it.
  }

  // Compose
  const parts = [];
  if (pokemonToken) {
    parts.push(pokemonToken);
  } else if (nameEn) {
    // No JP name resolved — use EN name as a weak fallback. Japanese
    // sellers frequently include English text in modern listings (e.g.,
    // "Charizard ex SAR" alongside the JP), and rare-card vintage
    // listings often quote the EN name for international buyers. Better
    // than firing a query with only set+era tokens.
    parts.push(nameEn);
  }
  if (setToken) parts.push(setToken);
  if (eraToken) parts.push(eraToken);

  // Last-ditch fallback: if absolutely nothing resolved, target generic
  // Pokemon TCG to at least narrow the noise floor.
  if (parts.length === 0) {
    parts.push("ポケモンカード");
  }

  return {
    query: parts.join(" "),
    parts: { pokemonToken, setToken, eraToken, fallback: parts.length === 0 },
    canonicalSlug: canonicalCard.slug,
  };
}

// =============================================================================
// 2. Listing scoring
// =============================================================================
/**
 * Score a single Yahoo! listing's match likelihood for the given canonical
 * card. Returns { score: 0.0–1.0, tier: "HIGH"|"MEDIUM"|"LOW", reasons }.
 *
 * Scoring is rule-based + transparent — every score has an audit trail of
 * which signals fired. This keeps the matcher debuggable: if you don't
 * trust a match, you can see exactly why we trusted it.
 *
 * Signals (positive):
 *   +0.30  Pokemon name token present (JP)
 *   +0.20  Set name token present
 *   +0.15  Card number matches (e.g., "4/102" or just "4")
 *   +0.10  Era marker matches (旧裏/新裏 + year band)
 *   +0.10  Trainer-prefix matches (Erika's, Blaine's, etc.) when
 *          canonical card has one
 *   +0.10  Edition marker matches (1ED, 第1弾)
 *
 * Signals (negative):
 *   -0.50  Hard-exclude token present (まとめ, セット, BOX, etc.)
 *   -0.30  Title contains a different specific Pokemon name
 *   -0.20  Title has wrong-era marker for canonical's expected era
 *   -0.10  Title has wrong-trainer-prefix for canonical with one
 */
export function scoreListing(listing, canonicalCard, opts = {}) {
  const title = String(listing.title ?? "");
  let score = 0;
  const reasons = [];

  const nameNative = canonicalCard.canonical_name_native?.trim();
  const nameEn = canonicalCard.canonical_name?.trim() ?? "";
  const setNative = canonicalCard.set_name_native?.trim();
  const setEn = canonicalCard.set_name?.trim() ?? "";
  const cardNumber = canonicalCard.card_number?.trim() ?? "";

  // --- positive: Pokemon name token ---
  // Use the same resolver as the query builder so the JP name we look
  // for in the listing matches the JP name we asked Yahoo! for. Without
  // this, prefixed cards ("Blaine's Charizard" → カツラのリザードン) would
  // construct correct queries but fail to match the listings they
  // returned.
  let pokemonJp = nameNative;
  if (!pokemonJp) {
    const resolved = resolveEnToJpName(nameEn);
    if (resolved) pokemonJp = resolved.jpName;
  }
  if (pokemonJp && title.includes(pokemonJp)) {
    score += 0.30;
    reasons.push(`+0.30 has-pokemon-jp (${pokemonJp})`);
  } else if (nameEn && new RegExp(`\\b${nameEn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(title)) {
    // Some JP listings include the EN name verbatim. Smaller bonus
    // because it's noisier (e.g., "Charizard" matches V/VMAX/etc).
    score += 0.15;
    reasons.push(`+0.15 has-pokemon-en (${nameEn})`);
  } else {
    reasons.push(`-0.00 missing-pokemon-name`);
  }

  // --- positive: Set name token ---
  const setJp = setNative ?? EN_TO_JP_SET[setEn] ?? null;
  if (setJp && title.includes(setJp)) {
    score += 0.20;
    reasons.push(`+0.20 has-set-jp (${setJp})`);
  } else if (setEn && title.includes(setEn)) {
    score += 0.10;
    reasons.push(`+0.10 has-set-en (${setEn})`);
  }

  // --- positive: Card number (loose) ---
  if (cardNumber && cardNumber.length >= 1) {
    // Strip any "-suffix" disambiguator we synthesized (see import script);
    // the listing won't have that.
    const baseNumber = cardNumber.split("-")[0];
    if (baseNumber) {
      const numberRegex = new RegExp(`(?:^|[^0-9])${baseNumber}(?:[^0-9]|$|/\\d+)`);
      if (numberRegex.test(title)) {
        score += 0.15;
        reasons.push(`+0.15 has-card-number (${baseNumber})`);
      }
    }
  }

  // --- positive: Era marker matches expected era ---
  const year = canonicalCard.year;
  if (typeof year === "number") {
    if (year >= 1996 && year <= 2002) {
      if (title.includes("旧裏") || title.includes("当時物")) {
        score += 0.10;
        reasons.push(`+0.10 era-vintage-matches`);
      }
      if (title.includes("新裏") || title.includes("復刻")) {
        score -= 0.20;
        reasons.push(`-0.20 era-modern-on-vintage-canonical`);
      }
    } else if (year >= 2003) {
      if (title.includes("旧裏") || title.includes("当時物")) {
        score -= 0.20;
        reasons.push(`-0.20 era-vintage-on-modern-canonical`);
      }
    }
  }

  // --- positive: Trainer-prefix matches ---
  // If canonical name has a trainer prefix (e.g., "Erika's Charizard"),
  // require the corresponding JP prefix in the title. If canonical has
  // NO prefix but title has one, that's a downgrade — different card.
  const canonicalEnHasPrefix = /^(erika|misty|brock|surge|blaine|koga|giovanni|sabrina|rocket|galarian|hisuian|alolan|paldean)['s]/i.test(nameEn);
  const titleTrainerPrefix = Object.keys(TRAINER_PREFIXES).find((jp) => title.includes(jp));
  if (canonicalEnHasPrefix) {
    if (titleTrainerPrefix) {
      const expectedEn = TRAINER_PREFIXES[titleTrainerPrefix];
      // Loose match: does the canonical EN name start with the expected EN prefix?
      if (nameEn.toLowerCase().startsWith(expectedEn.toLowerCase().replace(/'s$/, ""))) {
        score += 0.10;
        reasons.push(`+0.10 trainer-prefix-matches (${titleTrainerPrefix} = ${expectedEn})`);
      } else {
        score -= 0.10;
        reasons.push(`-0.10 trainer-prefix-mismatch (${titleTrainerPrefix} ≠ ${nameEn})`);
      }
    } else {
      // Canonical expects prefix, listing lacks it
      reasons.push(`-0.00 missing-expected-trainer-prefix`);
    }
  } else if (titleTrainerPrefix) {
    // Canonical has no prefix but listing does — different card
    score -= 0.10;
    reasons.push(`-0.10 unexpected-trainer-prefix-in-listing (${titleTrainerPrefix})`);
  }

  // --- positive: Edition marker on vintage cards ---
  if (typeof year === "number" && year <= 2002) {
    if (title.includes("第1弾") && setEn === "Expansion Pack") {
      score += 0.10;
      reasons.push(`+0.10 edition-1ed-matches-base-set`);
    }
  }

  // --- negative: Hard-exclude tokens ---
  const excludeHits = HARD_EXCLUDE_TOKENS.filter((t) => title.includes(t));
  if (excludeHits.length > 0) {
    score -= 0.50;
    reasons.push(`-0.50 hard-exclude-tokens (${excludeHits.join(",")})`);
  }

  // --- negative: Different specific JP set in title ---
  // A listing for "Delta Species Charizard" (set: さいはての攻防) gets a
  // false-positive set-jp match on Base Set Charizard's "拡張パック"
  // because both contain that token. The fix is to look for a DIFFERENT
  // specific JP set name in the title — one that's not a substring of
  // the canonical's own set name. If found, this is strong evidence we
  // matched the wrong physical card.
  const canonicalSetJpForCheck = setJp ?? "";
  const wrongSetHit = KNOWN_JP_SETS.find((s) => {
    if (!title.includes(s)) return false;
    // Skip canonical's own set (or any set that's a substring of it,
    // covering the case where canonical = "拡張パック 20th Anniversary"
    // and title contains "拡張パック").
    if (canonicalSetJpForCheck && (canonicalSetJpForCheck.includes(s) || s.includes(canonicalSetJpForCheck))) return false;
    return true;
  });
  if (wrongSetHit) {
    score -= 0.30;
    reasons.push(`-0.30 different-set-in-title (${wrongSetHit})`);
  }

  // --- negative: Different Pokemon name in title ---
  // Look at all glossary Pokemon entries; if title contains a different
  // Pokemon's name AND not our canonical Pokemon's name, downgrade.
  //
  // Important nuance: Japanese evolution-line names share roots — リザード
  // (Charmeleon) is a substring of リザードン (Charizard); ピカチュウ shares
  // characters with ピチュー. Naive substring containment fires on every
  // Charizard listing because リザード ⊂ リザードン.
  //
  // Fix: skip any "other" name X where X ⊂ canonical OR canonical ⊂ X.
  // That correctly suppresses evolution-line confusions while still
  // catching genuinely different Pokemon (e.g., Charizard listing with
  // "ピカチュウ" mentioned — different Pokemon entirely).
  if (pokemonJp) {
    const otherPokemon = Object.keys(POKEMON_NAMES).filter((jp) => {
      if (jp === pokemonJp) return false;
      // Evolution-pair / inflection skip: shared substring means related
      if (pokemonJp.includes(jp) || jp.includes(pokemonJp)) return false;
      return title.includes(jp);
    });
    if (otherPokemon.length > 0) {
      score -= 0.30;
      reasons.push(`-0.30 different-pokemon-in-title (${otherPokemon.slice(0, 3).join(",")})`);
    }
  }

  // Clamp + tier
  score = Math.max(0, Math.min(1, score));
  const tier = score >= 0.80 ? "HIGH" : score >= 0.50 ? "MEDIUM" : "LOW";

  return { score, tier, reasons };
}

// =============================================================================
// 3. Grade extraction
// =============================================================================
/**
 * Detect grading-service + grade from listing title. We use this to split
 * sold prices by grade — a PSA10 Charizard sells for ¥2M, raw for ¥30k —
 * conflating them gives garbage medians.
 *
 * Returns { company: "PSA"|"BGS"|"CGC"|"ARS"|"TAG"|null, grade: number|null }
 *
 * Falls back to RAW when no grade marker is present, with a heuristic
 * downgrade to "UNKNOWN" if 鑑定品 (graded) is mentioned but no specific
 * grade — those listings are unreliable for raw/graded splitting.
 *
 * Grade-catalog interop (added 2026-05-08): when the orchestrator writes
 * a graded-bucket row to yahoo_jp_card_prices, the grade text passes
 * through `resolve_grade_id()`. Any string not in `grade_definitions`
 * or `grade_aliases` is rejected by the trigger. The labels this
 * function emits ("PSA10", "CGC10", "BGS9.5", "ARS7", "TAG9.5") need
 * matching catalog rows before the orchestrator graduates from RAW-only
 * writes. PSA10 (grade_id=9) and RAW (grade_id=1) are already covered.
 * See docs/schema-audit-2026-05-08.md §8 item 3 for the grader-specific
 * vs alias-to-generic-bucket trade-off.
 */
export function extractGrade(listing) {
  const title = String(listing.title ?? "");

  // Primary: regex for grader + numeric grade.
  // Numeric grade is constrained to 1-10 (with optional .5) to avoid
  // false positives like "PSA 1996" where 1996 is a card year.
  const m = title.match(/\b(PSA|BGS|CGC|ARS|TAG)\s*(10|[1-9](?:\.[05])?)\b(?!\d)/i);
  if (m) {
    const grade = Number.parseFloat(m[2]);
    if (grade >= 1 && grade <= 10) {
      return {
        company: m[1].toUpperCase(),
        grade,
        raw: false,
        label: `${m[1].toUpperCase()}${m[2]}`,
      };
    }
  }

  // Secondary: 鑑定品 marker without specific grade — ambiguous
  if (title.includes("鑑定品") || title.includes("鑑定済") || listing.isAppraisal === true) {
    return { company: null, grade: null, raw: false, label: "GRADED_UNKNOWN" };
  }

  // Default: raw card
  return { company: null, grade: null, raw: true, label: "RAW" };
}

// =============================================================================
// 4. Hard-exclusion pre-filter
// =============================================================================
/**
 * Drop listings that are obviously not a single card based on title +
 * category. Runs before scoring to save downstream work; identical to
 * what scoreListing penalizes, but as a binary filter so noisy inputs
 * never reach the price aggregator at all.
 */
export function applyHardExclusions(listings) {
  return listings.filter((l) => {
    const title = String(l.title ?? "");

    // Wrong category leaf — Yahoo! sometimes returns category drift even
    // with auccat= on the URL. The single-card category leaf is
    // 2084317608 / "シングルカード".
    if (l.leafCategoryId && l.leafCategoryId !== 2084317608) return false;
    if (l.leafCategoryName && l.leafCategoryName !== "シングルカード") return false;

    // Hard-exclude tokens
    for (const token of HARD_EXCLUDE_TOKENS) {
      if (title.includes(token)) return false;
    }

    // Drop listings with no price (rare but possible)
    if (typeof l.price !== "number" || l.price <= 0) return false;

    return true;
  });
}

// =============================================================================
// 5. Orchestration
// =============================================================================
/**
 * End-to-end matcher: takes raw scraper output + canonical card →
 * grouped, scored, grade-split match results.
 *
 * Output:
 * {
 *   query: { ... },
 *   inputCount: number,
 *   afterExclusion: number,
 *   matches: { HIGH: [...], MEDIUM: [...], LOW: [...] },
 *   priceObservations: [
 *     { grade: "RAW", count: N, median: ¥X, p25: ¥X, p75: ¥X, samples: [...] },
 *     { grade: "PSA10", count: N, median: ¥X, ... },
 *     ...
 *   ],
 *   warnings: [...]
 * }
 */
export function selectMatched(listings, canonicalCard, opts = {}) {
  const minScore = opts.minScore ?? 0.50; // include MEDIUM and HIGH
  const inputCount = listings.length;
  const filtered = applyHardExclusions(listings);

  const scored = filtered.map((l) => {
    const result = scoreListing(l, canonicalCard);
    const grade = extractGrade(l);
    return { listing: l, score: result.score, tier: result.tier, reasons: result.reasons, grade };
  });

  const tiers = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const s of scored) tiers[s.tier].push(s);

  // Group accepted (score >= minScore) by grade label, compute price stats
  const accepted = scored.filter((s) => s.score >= minScore);
  const byGrade = new Map();
  for (const s of accepted) {
    const label = s.grade.label;
    if (!byGrade.has(label)) byGrade.set(label, []);
    byGrade.get(label).push(s);
  }

  const priceObservations = [];
  for (const [label, group] of byGrade) {
    const prices = group.map((s) => s.listing.price).filter((p) => typeof p === "number" && p > 0);
    if (prices.length === 0) continue;
    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const p25 = prices[Math.floor(prices.length * 0.25)];
    const p75 = prices[Math.floor(prices.length * 0.75)];
    priceObservations.push({
      grade: label,
      count: prices.length,
      median,
      p25,
      p75,
      min: prices[0],
      max: prices[prices.length - 1],
      samples: group.slice(0, 5).map((s) => ({
        title: s.listing.title.slice(0, 80),
        price: s.listing.price,
        score: s.score,
        url: s.listing.itemUrl,
      })),
    });
  }
  // Sort observations: RAW first, then by grade descending
  priceObservations.sort((a, b) => {
    if (a.grade === "RAW") return -1;
    if (b.grade === "RAW") return 1;
    return b.grade.localeCompare(a.grade);
  });

  const warnings = [];
  if (inputCount === 0) warnings.push("scraper returned zero listings — query may be too narrow");
  if (filtered.length === 0 && inputCount > 0) warnings.push("all listings excluded by category/token filter");
  if (accepted.length === 0 && filtered.length > 0) warnings.push("all listings scored below minScore — query may be matching wrong card");
  const rawObs = priceObservations.find((o) => o.grade === "RAW");
  if (rawObs && rawObs.count < 3) warnings.push(`only ${rawObs.count} raw price points — low confidence`);

  return {
    canonicalSlug: canonicalCard.slug,
    inputCount,
    afterExclusion: filtered.length,
    accepted: accepted.length,
    tiers: {
      HIGH: tiers.HIGH.length,
      MEDIUM: tiers.MEDIUM.length,
      LOW: tiers.LOW.length,
    },
    priceObservations,
    warnings,
    // Detailed listings for debugging — caller can drop if too verbose
    detail: { tiers, accepted },
  };
}
