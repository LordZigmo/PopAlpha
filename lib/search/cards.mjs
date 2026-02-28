import { normalizeSearchInput } from "./normalize.mjs";
import { compareRankedSearchRows, computeSearchSignals } from "./rank.mjs";

function matchesAllTokens(text, tokens) {
  return tokens.every((token) => text.includes(token));
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
    const isDirect = qNorm.length > 0 && rowNorm.includes(qNorm);
    const aliasNorms = aliasNormsBySlug.get(row.canonical_slug) ?? [];
    const isAlias = aliasNorms.length > 0;
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
