import { normalizeSearchInput } from "./normalize.mjs";
import {
  compareRankedSearchRows,
  computeSearchSignals,
  normalizeCardNumber,
} from "./rank.mjs";

function isNumericToken(token) {
  return /^\d+$/.test(token);
}

function matchesToken(text, token) {
  if (!text || !token) return false;
  if (isNumericToken(token)) {
    return ` ${text} `.includes(` ${token} `);
  }
  return text.includes(token);
}

function matchesAllTokens(text, tokens) {
  return tokens.every((token) => matchesToken(text, token));
}

function matchesNormalizedPhrase(text, normalizedText) {
  if (!text || !normalizedText) return false;
  const phraseTokens = normalizedText.split(" ").filter(Boolean);
  if (phraseTokens.length === 1) {
    return matchesToken(text, phraseTokens[0]);
  }
  return text.includes(normalizedText);
}

/**
 * Reprint sets duplicate a card's name AND collector number across
 * sets (e.g. Surging Sparks Pikachu ex #57 → ME: Ascended Heroes
 * Pikachu ex #57). With the default year-DESC tiebreak, every 2026
 * reprint outranked the 2024 original, burying it below the fold of
 * fixed-height pickers (the iOS scan-correction sheet shows 8 rows —
 * user report 2026-07-01: the pulled card "wasn't in the list").
 *
 * Post-sort, pull rows that tie on score AND share (canonical name,
 * collector number, language) together at the group's best rank,
 * ordered oldest-first so the original printing leads its reprints.
 * Scoped to equal scores on purpose: when the query names a set,
 * set_number_match / token coverage already split the scores and
 * this regrouping stays out of the way.
 */
function regroupReprintTies(sortedRows) {
  const groups = new Map();
  const orderedKeys = [];
  for (const row of sortedRows) {
    const numberNorm = normalizeCardNumber(row.card_number ?? "");
    const nameNorm = row.canonical_name_norm ?? "";
    // JP slugs carry a -jp suffix; keep languages in separate groups so
    // a same-numbered JP printing doesn't interleave with EN results.
    const langBucket = row.canonical_slug.endsWith("-jp") ? "jp" : "en";
    const key =
      numberNorm && nameNorm
        ? `${row.score}|${nameNorm}|${numberNorm}|${langBucket}`
        : `solo|${orderedKeys.length}`;
    const members = groups.get(key);
    if (members) {
      members.push(row);
    } else {
      groups.set(key, [row]);
      orderedKeys.push(key);
    }
  }
  const out = [];
  for (const key of orderedKeys) {
    const members = groups.get(key);
    if (members.length > 1) {
      // Stable sort: oldest (original printing) first, unknown years
      // last, sorted-rank order preserved between equal years.
      members.sort(
        (a, b) =>
          (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER),
      );
    }
    out.push(...members);
  }
  return out;
}

export function buildSearchCardResults({
  canonicalRows,
  aliasRows,
  query,
  limit = 20,
}) {
  const normalized = typeof query === "string" ? normalizeSearchInput(query) : query;
  const qNorm = normalized.normalized_text;
  const aliasNormsBySlug = new Map();
  for (const row of aliasRows) {
    const current = aliasNormsBySlug.get(row.canonical_slug) ?? [];
    current.push(row.alias_norm ?? "");
    aliasNormsBySlug.set(row.canonical_slug, current);
  }

  const deduped = new Map();
  for (const row of canonicalRows) {
    const rowNorm = row.search_doc_norm ?? "";
    const isDirect = qNorm.length > 0 && matchesNormalizedPhrase(rowNorm, qNorm);
    const aliasNorms = aliasNormsBySlug.get(row.canonical_slug) ?? [];
    const isAlias = aliasNorms.some(
      (aliasNorm) => matchesNormalizedPhrase(aliasNorm, qNorm) || matchesAllTokens(aliasNorm, normalized.tokens),
    );
    if (!isDirect && !isAlias && !matchesAllTokens(rowNorm, normalized.tokens)) continue;

    const signals = computeSearchSignals(row, aliasNorms, normalized);

    deduped.set(row.canonical_slug, {
      canonical_slug: row.canonical_slug,
      canonical_name: row.canonical_name,
      set_name: row.set_name,
      card_number: row.card_number,
      year: row.year,
      primary_image_url: row.primary_image_url ?? null,
      search_doc_norm: rowNorm,
      ...signals,
    });
  }

  return regroupReprintTies([...deduped.values()].sort(compareRankedSearchRows))
    .slice(0, limit)
    .map((row) => ({
      canonical_slug: row.canonical_slug,
      canonical_name: row.canonical_name,
      set_name: row.set_name,
      card_number: row.card_number,
      year: row.year,
      primary_image_url: row.primary_image_url,
    }));
}
