import { normalizeSearchInput } from "./normalize.mjs";
import { compareRankedSearchRows, computeSearchSignals } from "./rank.mjs";

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

  return [...deduped.values()]
    .sort(compareRankedSearchRows)
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
