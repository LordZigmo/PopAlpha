/**
 * Shared search normalization.
 *
 * Normalization spec:
 * 1. Lowercase
 * 2. NFKD + strip diacritics
 * 3. Convert punctuation/separators to spaces, keep alphanumerics
 * 4. Collapse whitespace
 * 5. Tokenize on spaces
 * 6. Numeric tokens lose leading zeros
 * 7. Return normalized text + tokens + numeric tokens
 */

/**
 * Strip combining marks (accents/diacritics) from a string by NFKD-decomposing
 * it and removing the combining-mark range. After this, "Pokémon" → "Pokemon"
 * and "Poké Ball" → "Poke Ball".
 *
 * Exported because every slug-generating helper in this codebase MUST run
 * input through this BEFORE the `[^a-z0-9]+ → -` regex, or accented
 * characters get treated as separators (turning "Pokémon" → "pok-mon").
 * That bug split 216 distinct cards across two canonical_slugs in 2026-04;
 * see supabase/migrations/20260428_dedupe_accent_bug_canonical_slugs.sql.
 */
export function stripDiacritics(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeNumericToken(token) {
  if (!/^\d+$/.test(token)) return token;
  const normalized = token.replace(/^0+(?=\d)/, "");
  return normalized.length > 0 ? normalized : "0";
}

function dedupePreserveOrder(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function normalizeSearchInput(input) {
  const raw = String(input ?? "");
  const lowered = stripDiacritics(raw).toLowerCase();
  const collectorNumberParts = [];
  const collectorPartSeen = new Set();

  for (const match of lowered.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)) {
    const first = normalizeNumericToken(match[1]);
    const second = normalizeNumericToken(match[2]);
    for (const part of [first, second]) {
      if (!collectorPartSeen.has(part)) {
        collectorPartSeen.add(part);
        collectorNumberParts.push(part);
      }
    }
  }

  const separated = lowered.replace(/[^a-z0-9]+/g, " ");
  const collapsed = separated.replace(/\s+/g, " ").trim();

  const processedTokens = collapsed.length === 0
    ? []
    : collapsed
        .split(" ")
        .filter(Boolean)
        .map((token) => normalizeNumericToken(token));

  const tokens = dedupePreserveOrder(processedTokens);
  const numericTokens = dedupePreserveOrder(tokens.filter((token) => /^\d+$/.test(token)));

  return {
    normalized_text: tokens.join(" "),
    tokens,
    numeric_tokens: numericTokens,
    collector_number_parts: collectorNumberParts,
  };
}

export function normalizeSearchText(input) {
  return normalizeSearchInput(input).normalized_text;
}

export function buildCanonicalSearchDoc(fields) {
  const parts = [
    fields.canonical_name ?? "",
    fields.subject ?? "",
    fields.set_name ?? "",
    fields.card_number ?? "",
    fields.year == null ? "" : String(fields.year),
  ];

  return parts
    .map((value) => String(value).replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0)
    .join(" ");
}
