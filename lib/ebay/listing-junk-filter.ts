// Lottery-listing detection for eBay Browse results, shared by
// app/api/ebay/browse/route.ts and locked by
// tests/ebay-browse-junk-filter.test.mjs. Extracted from the route
// (route files can't export helpers) after four independent failure
// modes surfaced in review on PR #241 — every case lives in the test
// matrix; extend it before changing these patterns.

/// Normalization shared by the browse route's relevance filters and
/// the junk patterns below: lowercase, every non-alphanumeric run
/// (punctuation, accents — "Pokémon" → "pok mon") collapsed to a
/// single space.
export function normalizeListingText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Lottery-style listings — mystery packs/boxes/bags, grab bags, repacks,
// oripa (JP random-pull packs), fukubukuro "lucky bags" — advertise the
// chase card's name + number in the title, so they sail through the
// browse route's name/number relevance gates while not actually selling
// that card. Patterns run against normalizeListingText output,
// word-bounded to avoid swallowing real card names like "Mysterious
// Treasures".
//
// "mystery" requires a concrete lottery noun — bare \bmystery\b dropped
// real singles whose titles carry it as metadata, e.g. "Pokémon Mystery
// Dungeon … Promo" (codex P2 #3 on PR #241). Up to two ALLOWLISTED
// product words may sit between "mystery" and the noun ("Mystery
// Pokemon Pack", "Mystery Card Lot" — codex P2 #4); the allowlist, not
// a bare \w+ gap, is what keeps "Mystery Dungeon Box" singles alive.
// "pok|mon" looks odd but is load-bearing: normalizeListingText strips
// the é from "Pokémon", leaving the two tokens "pok mon". Deliberate
// tradeoff: a noun-less title like "MYSTERY read description" slips
// through; every observed real lottery listing names one of these
// nouns.
export const JUNK_LISTING_PATTERNS = [
  /\bmystery (?:(?:pokemon|pok|mon|tcg|cards?|singles?|holo|premium|japanese|english|jp|chase) ){0,2}(?:packs?|box(es)?|bags?|grabs?|bundles?|lots?|pulls?|chase)\b/,
  /\bgrab bags?\b/,
  /\boripa\b/,
  /\blucky bags?\b/,
  /\brepacks?\b/,
];

/// True when a listing title is a lottery-style listing rather than a
/// sale of the requested card. Both arguments must already be in
/// normalizeListingText space.
///
/// Strips the requested card/set phrases out of the title and tests the
/// junk patterns on the residual text. The requested wording itself can
/// then never trip a pattern — a single from 化石の秘密 (rendered
/// "Mystery of the Fossils" by this repo's JP glossary, and repeated
/// verbatim by legitimate listings) survives — while a standalone
/// lottery term in the SAME title still fires: "Mystery of the Fossils
/// MYSTERY PACK chase" reduces to "mystery pack chase". (Codex P2 ×2 on
/// PR #241: phrase-level waivers first dropped legit mystery-set
/// singles, then leaked lottery packs for mystery-named requests.)
export function isJunkListingTitle(title: string, requestedPhrases: string[]): boolean {
  let residual = title;
  for (const phrase of requestedPhrases) {
    if (!phrase) continue;
    residual = residual.split(phrase).join(" ");
  }
  residual = residual.replace(/\s+/g, " ").trim();
  return JUNK_LISTING_PATTERNS.some((pattern) => pattern.test(residual));
}
