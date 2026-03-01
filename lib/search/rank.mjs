import { normalizeSearchInput, normalizeSearchText } from "./normalize.mjs";

const WEIGHTS = {
  set_number_match: 1000,
  number_match: 850,
  exact_name_match: 700,
  alias_match: 500,
  exact_norm_match: 300,
  prefix_match: 100,
  token_coverage_max: 50,
};

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

function normalizeCardNumber(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) return "";
  return /^\d+$/.test(normalized) ? normalized : normalized.split(" ")[0] ?? "";
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function computeSearchSignals(row, aliasNorms, query) {
  const normalized = typeof query === "string" ? normalizeSearchInput(query) : query;
  const qNorm = normalized.normalized_text;
  const rowNorm = row.search_doc_norm ?? "";
  const canonicalNameNorm = normalizeSearchText(row.canonical_name);
  const setTokens = normalizeSearchInput(row.set_name ?? "").tokens;
  const numericSet = new Set(normalized.numeric_tokens);
  const collectorPrimary = normalized.collector_number_parts[0] ?? null;
  const normalizedCardNumber = normalizeCardNumber(row.card_number ?? "");

  const exact_norm_match =
    rowNorm === qNorm || aliasNorms.some((aliasNorm) => aliasNorm === qNorm);

  const setTokenIntersection = normalized.tokens.filter((token) => setTokens.includes(token));
  const number_match =
    normalized.numeric_tokens.length > 0 &&
    (
      numericSet.has(normalizedCardNumber) ||
      (collectorPrimary !== null && normalizedCardNumber === collectorPrimary)
    );

  const set_number_match =
    number_match &&
    setTokenIntersection.length > 0;

  const nameIntentTokens = normalized.tokens.filter((token) => {
    if (numericSet.has(token)) return false;
    if (setTokens.includes(token)) return false;
    return true;
  });
  const nameIntentNorm = nameIntentTokens.join(" ");
  const exact_name_match =
    nameIntentNorm.length > 0 && canonicalNameNorm === nameIntentNorm;

  const alias_match = aliasNorms.some(
    (aliasNorm) => matchesNormalizedPhrase(aliasNorm, qNorm) || matchesAllTokens(aliasNorm, normalized.tokens),
  );

  const matchedTokenCount = normalized.tokens.filter((token) => matchesToken(rowNorm, token)).length;
  const token_coverage = normalized.tokens.length > 0
    ? matchedTokenCount / normalized.tokens.length
    : 0;

  const prefixPhrase = nameIntentNorm || qNorm;
  const prefix_match =
    prefixPhrase.length > 0 &&
    (canonicalNameNorm.startsWith(prefixPhrase) || canonicalNameNorm.includes(prefixPhrase));

  const score =
    (set_number_match ? WEIGHTS.set_number_match : 0) +
    (number_match ? WEIGHTS.number_match : 0) +
    (exact_name_match ? WEIGHTS.exact_name_match : 0) +
    (alias_match ? WEIGHTS.alias_match : 0) +
    (exact_norm_match ? WEIGHTS.exact_norm_match : 0) +
    (prefix_match ? WEIGHTS.prefix_match : 0) +
    Math.round(token_coverage * WEIGHTS.token_coverage_max);

  return {
    exact_norm_match,
    set_number_match,
    number_match,
    exact_name_match,
    alias_match,
    token_coverage,
    prefix_match,
    score,
    q_norm: qNorm,
    canonical_name_norm: canonicalNameNorm,
    set_tokens: unique(setTokens),
    name_intent_norm: nameIntentNorm,
  };
}

export function compareRankedSearchRows(a, b) {
  if (a.score !== b.score) return b.score - a.score;

  const yearA = a.year ?? 0;
  const yearB = b.year ?? 0;
  if (yearA !== yearB) return yearB - yearA;

  const setA = a.set_name ?? "";
  const setB = b.set_name ?? "";
  const setCmp = setA.localeCompare(setB);
  if (setCmp !== 0) return setCmp;

  const nameCmp = a.canonical_name.localeCompare(b.canonical_name);
  if (nameCmp !== 0) return nameCmp;

  return a.canonical_slug.localeCompare(b.canonical_slug);
}
