import { normalizeSearchInput } from "./normalize.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractHighlightTokens(query) {
  return normalizeSearchInput(query).tokens.filter((token) => token.length > 0);
}

export function buildHighlightSegments(text, queryOrTokens) {
  const source = String(text ?? "");
  if (!source) return [{ text: "", match: false }];

  const tokens = Array.isArray(queryOrTokens)
    ? queryOrTokens.filter((token) => typeof token === "string" && token.length > 0)
    : extractHighlightTokens(queryOrTokens);

  if (tokens.length === 0) {
    return [{ text: source, match: false }];
  }

  const pattern = new RegExp(`(${tokens.map((token) => escapeRegExp(token)).join("|")})`, "gi");
  const parts = source.split(pattern).filter((part) => part.length > 0);

  if (parts.length === 0) {
    return [{ text: source, match: false }];
  }

  return parts.map((part) => ({
    text: part,
    match: tokens.some((token) => part.toLowerCase() === token.toLowerCase()),
  }));
}
