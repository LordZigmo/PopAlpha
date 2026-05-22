/**
 * EN <-> JP card-pairing gate + threshold logic.
 *
 * Shared by:
 *   - scripts/backfill-card-translations.mjs (manual bulk runs)
 *   - app/api/cron/refresh-card-translations/route.ts (weekly cron)
 *
 * History: both consumers originally carried their own copy of the gate
 * and the picker. The May-2026 case-sensitivity bug had to be fixed in
 * two places at once (commit eb0f8e2); the next gate change would have
 * drifted them again. Centralizing here so the two stay in lockstep.
 *
 * What changed vs the original glossary-only gate (PR #67):
 *   - The original code gated kNN candidates through the static
 *     EN_TO_JP_POKEMON glossary (~50 hand-curated species). Cards
 *     outside the glossary fell through to a 0.94 cosine floor that
 *     cross-language SigLIP almost never clears, yielding 0.2% (1/500)
 *     pairings on prod. See plans/we-need-to-work-cozy-shannon.md for
 *     the full diagnosis.
 *   - The new gate prefers `canonical_cards.canonical_name` equality
 *     ("STRICT_MATCH"). That column is populated in EN-form on BOTH
 *     EN and JP rows by the Scrydex importer; 100% of attempted-
 *     unpaired EN slugs have a JP candidate with matching
 *     canonical_name, and 50% have name+card_number aligned.
 *   - The static glossary stays as a fallback ("GLOSSARY_MATCH") for
 *     the ~5% tail where the two sides' canonical_name strings diverge
 *     (regional variants, trainer-prefix nuances).
 *   - Cosine thresholds are now tiered by gate quality: STRICT+number
 *     pairs accept at 0.75 cosine (the kNN ordering is already strong
 *     evidence at that point); STRICT-without-number raises to 0.85;
 *     GLOSSARY stays at the legacy 0.90; and a null gate (no signal
 *     either way) still demands 0.94.
 *
 * Everything below is pure: no DB access, no I/O. The caller wires the
 * kNN query, hydrates JP candidate rows with the columns this module
 * needs, and persists the chosen pairings.
 */

import { EN_TO_JP_POKEMON } from "./matcher.mjs";

// Strict normalization is intentionally just lowercase+trim. Suffixes
// like " ex" / " V" / " VMAX" must be preserved: "Mew" and "Mew ex"
// are DIFFERENT cards, and stripping the suffix would let a Mew-ex EN
// card STRICT_MATCH a plain Mew JP card when both happen to share a
// card_number, writing rank=0 at cosine 0.75. Codex P2 on PR #109.
// Case differences ("ex" vs "EX") are the only divergence we accept;
// canonical_name strings are otherwise consistent across language
// because the Scrydex importer normalizes both sides identically.

export const THRESHOLDS = Object.freeze({
  TOP_K: 8,
  ALT_RANK_MAX: 2,

  // Tier 1 — STRICT_MATCH: en.canonical_name == jp.canonical_name
  // (case-insensitive, suffix-stripped). When card_number also matches
  // we have name + number + visual agreement, which is overwhelmingly
  // sufficient even at modest cosines. When numbers differ we raise
  // the floor so cross-set reprints of the same name don't pair on
  // art alone.
  STRICT_PRIMARY_COSINE_WITH_NUMBER: 0.75,
  STRICT_ALT_COSINE_WITH_NUMBER: 0.70,
  STRICT_PRIMARY_COSINE_NO_NUMBER: 0.85,
  STRICT_ALT_COSINE_NO_NUMBER: 0.80,

  // Tier 2 — GLOSSARY_MATCH: legacy behavior, preserved for the tail
  // of pairs whose EN-form canonical_name strings diverge across
  // language. The static EN_TO_JP_POKEMON glossary is the only signal
  // available in those cases.
  GLOSSARY_PRIMARY_COSINE: 0.90,
  GLOSSARY_ALT_COSINE: 0.85,

  // Tier 4 — no gate signal at all (both sides missing the data the
  // gate needs). Demand near-identical embeddings before linking on
  // art alone. Rare in practice now that JP cards carry both
  // canonical_name and canonical_name_native.
  NO_GATE_FLOOR_COSINE: 0.94,
});

/**
 * Normalize a canonical_name for STRICT match comparison: trim + lower
 * only. Suffix-stripping was REMOVED after Codex P2 on PR #109 — see
 * the VARIANT_SUFFIX_RE comment above.
 */
export function normalizeForStrictMatch(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Three-tier name gate.
 *
 *   STRICT_MATCH    en.canonical_name == jp.canonical_name (post-normalize)
 *   GLOSSARY_MATCH  EN_TO_JP_POKEMON[species] is a substring of
 *                   jp.canonical_name_native
 *   MISS            glossary disagrees — same species lookup yields a
 *                   different JP species name than what's in the JP
 *                   candidate's native name. Reject even at high cosine.
 *   null            neither side has the data to decide. Caller falls
 *                   back to NO_GATE_FLOOR_COSINE.
 *
 * STRICT_MATCH wins outright. We only consult the glossary when the
 * canonical_name strings disagree.
 *
 * Inputs are plain objects (the shape returned by canonical_cards
 * SELECTs); we read canonical_name, canonical_name_native, and nothing
 * else. Callers must include canonical_name in their JP-candidate
 * hydrate query — both consumers already do.
 */
export function nameGate(enCard, jpCard) {
  const enName = (enCard?.canonical_name ?? "").trim();
  const jpName = (jpCard?.canonical_name ?? "").trim();
  if (enName && jpName && normalizeForStrictMatch(enName) === normalizeForStrictMatch(jpName)) {
    return "STRICT_MATCH";
  }

  // Glossary path — match EN species against JP native name.
  // EN_TO_JP_POKEMON is title-cased by construction; canonical_name is
  // also title-cased. Lowercasing here would re-trigger the May 15
  // bug (commit eb0f8e2) where every lookup missed. The .toLowerCase
  // case is only applied inside normalizeForStrictMatch, which sits
  // above this path.
  const enSpecies = enName.split(/\s+/)[0] ?? "";
  const glossary = /** @type {Record<string, string>} */ (EN_TO_JP_POKEMON);
  const expectedJp = glossary[enName] ?? glossary[enSpecies] ?? null;
  const jpNative = (jpCard?.canonical_name_native ?? "").trim();

  if (!expectedJp || !jpNative) return null;
  if (jpNative.includes(expectedJp)) return "GLOSSARY_MATCH";

  // Glossary has a strong opinion ("Charizard ↔ リザードン") and the JP
  // candidate disagrees ("リザード" = Charmeleon). This is a same-name
  // EN listing landing in a different-Pokemon JP kNN bucket; reject.
  return "MISS";
}

/**
 * card_number tiebreak. Returns true when the two cards' numbers agree
 * after normalization. Tolerates "058/102" vs "58", "001" vs "1", etc.
 */
export function cardNumberMatch(enCard, jpCard) {
  const a = String(enCard?.card_number ?? "").trim();
  const b = String(jpCard?.card_number ?? "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const norm = (s) => s.split("/")[0].replace(/^0+(?=\d)/, "").trim();
  return norm(a) === norm(b);
}

/**
 * Resolve (primaryCosine, altCosine) thresholds for a candidate given
 * the gate result and whether card_number agrees. Exported so the unit
 * tests can pin the matrix directly.
 */
export function resolveCosineFloors(gateResult, numbersMatch, thresholds = THRESHOLDS) {
  switch (gateResult) {
    case "STRICT_MATCH":
      return numbersMatch
        ? { primary: thresholds.STRICT_PRIMARY_COSINE_WITH_NUMBER, alt: thresholds.STRICT_ALT_COSINE_WITH_NUMBER }
        : { primary: thresholds.STRICT_PRIMARY_COSINE_NO_NUMBER, alt: thresholds.STRICT_ALT_COSINE_NO_NUMBER };
    case "GLOSSARY_MATCH":
      return { primary: thresholds.GLOSSARY_PRIMARY_COSINE, alt: thresholds.GLOSSARY_ALT_COSINE };
    case "MISS":
      return { primary: Infinity, alt: Infinity }; // unreachable -> reject
    case null:
    default:
      return { primary: thresholds.NO_GATE_FLOOR_COSINE, alt: thresholds.NO_GATE_FLOOR_COSINE };
  }
}

/**
 * Given an EN canonical card + its top-K kNN JP candidates (each
 * carrying { jp_slug, cosine, card }), decide which JP pairings to
 * write. Returns at most one rank=0 row plus up to ALT_RANK_MAX
 * alternates.
 *
 * The kNN's `cosine` is the dominant signal. card_number agreement
 * adds a +0.02 boost used purely for ordering ties; it does NOT lift
 * a candidate over the raw cosine floor (see the "Primary must clear
 * the cosine floor on its own merits" comment further down — a Codex
 * P2 catch on PR #67).
 *
 * Candidates pass the gate at thresholds determined by (gateResult,
 * numbersMatch) via resolveCosineFloors. The primary is the highest-
 * score candidate that also clears the PRIMARY cosine floor under
 * its own gate result; the remaining accepted candidates (cleared
 * ALT floor) ride along as rank>=1 alternates.
 *
 * Output rows shape:
 *   { jp_slug, confidence, rank, gateResult, numbersMatch, reason }
 *
 * `gateResult`/`numbersMatch`/`reason` are diagnostic-only and not
 * persisted to card_translations. Callers that want verbose logging
 * read them; the upsert ignores them.
 */
export function pickPairings(enCard, candidates, opts = {}) {
  const thresholds = opts.thresholds ?? THRESHOLDS;
  const altRankMax = opts.altRankMax ?? thresholds.ALT_RANK_MAX;

  const scored = candidates
    .filter((c) => c?.card)
    .map((c) => {
      const numbersMatch = cardNumberMatch(enCard, c.card);
      return { ...c, numbersMatch, score: c.cosine + (numbersMatch ? 0.02 : 0) };
    })
    .sort((a, b) => b.score - a.score);

  // Walk every kNN candidate to completion — no early break. The break
  // is unsafe under the new tiered floors: a STRICT-no-number cluster
  // at cosine 0.80–0.84 can fill `accepted` (each clears its 0.80 alt
  // floor but fails its 0.85 primary floor) and stop iteration before
  // a lower-score STRICT+number candidate at cosine 0.75 — which IS a
  // valid rank=0 under its 0.75 primary floor — is examined. Codex P2
  // on this PR. With TOP_K=8 the cost of removing the cap is at most
  // 8 in-memory candidate evaluations per EN slug; the original break
  // saved nothing material.
  const accepted = [];
  for (const cand of scored) {
    const gateResult = nameGate(enCard, cand.card);
    if (gateResult === "MISS") continue;
    const floors = resolveCosineFloors(gateResult, cand.numbersMatch, thresholds);
    if (cand.cosine < floors.alt) continue;
    accepted.push({ ...cand, gateResult, floors });
  }
  if (accepted.length === 0) return [];

  // Primary must clear PRIMARY cosine on raw cosine (not score+boost).
  // The boost is an ordering tiebreak — promoting a sub-threshold
  // candidate to rank=0 just because numbers happened to match would
  // surface a noisy pair to readers via the EN/JP toggle. Codex P2 on
  // PR #67 walked us through this; preserved verbatim.
  const primary = accepted.find((c) => c.cosine >= c.floors.primary);
  if (!primary) return [];
  const alts = accepted.filter((c) => c !== primary).slice(0, altRankMax);

  const buildRow = (cand, rank) => ({
    jp_slug: cand.card.slug,
    confidence: cand.cosine,
    rank,
    gateResult: cand.gateResult,
    numbersMatch: cand.numbersMatch,
    reason: `${cand.gateResult}${cand.numbersMatch ? "+number" : ""} cos=${cand.cosine.toFixed(4)}`,
  });

  const rows = [buildRow(primary, 0)];
  alts.forEach((a, i) => rows.push(buildRow(a, i + 1)));
  return rows;
}
