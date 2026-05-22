import { stripDiacritics } from "./search/normalize.mjs";

function slugTokens(value) {
  return stripDiacritics(String(value ?? ""))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function titleCaseToken(token) {
  if (token.length === 1) return token.toUpperCase();
  return token.slice(0, 1).toUpperCase() + token.slice(1);
}

function titleCaseSlugTokens(tokens) {
  const parts = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "s" && i < tokens.length - 1 && parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}'s`;
      continue;
    }
    parts.push(titleCaseToken(token));
  }

  return parts.join(" ");
}

function trimSetPrefix(tokens, setName) {
  const setTokens = slugTokens(setName);
  let index = 0;
  while (index < tokens.length && index < setTokens.length && tokens[index] === setTokens[index]) {
    index += 1;
  }
  return tokens.slice(index);
}

function trimCardNumberPrefix(tokens, cardNumber) {
  if (tokens.length === 0) return tokens;

  const first = tokens[0];
  const numeric = /^\d+$/.test(first);
  const alphanumericPromo = /\d/.test(first) && /^[a-z0-9]+$/.test(first);
  const matchesActual = String(cardNumber ?? "").toLowerCase().includes(first);

  return numeric || alphanumericPromo || matchesActual ? tokens.slice(1) : tokens;
}

export function displayNameFromCanonicalSlug(slug, options = {}) {
  const allTokens = slugTokens(slug);
  if (allTokens.length === 0) return String(slug ?? "");

  let tokens = trimSetPrefix(allTokens, options.setName);
  tokens = trimCardNumberPrefix(tokens, options.cardNumber);

  return titleCaseSlugTokens(tokens.length > 0 ? tokens : allTokens);
}
