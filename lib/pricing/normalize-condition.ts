/**
 * Normalize a raw condition string to a stable lowercase token.
 * e.g. "Near Mint" → "nm", "Sealed" → "sealed", "Lightly Played" → "lp".
 * Unknown values fall back to lowercase-no-spaces (never throws).
 *
 * Extracted from lib/providers/justtcg.ts on 2026-04-17 so that Scrydex
 * code can continue using the normalization without depending on the
 * retired JustTCG provider lib.
 */

// Condition abbreviation map. Covers the standard TCG grading vocabulary
// used by every provider we've integrated with.
const CONDITION_ABBREV: Record<string, string> = {
  "near mint":        "nm",
  "lightly played":   "lp",
  "moderately played":"mp",
  "heavily played":   "hp",
  "damaged":          "dmg",
  "sealed":           "sealed",
};

export function normalizeCondition(condition: string): string {
  const key = condition.toLowerCase().trim().replace(/\s+/g, " ");
  return CONDITION_ABBREV[key] ?? key.replace(/\s+/g, "");
}
