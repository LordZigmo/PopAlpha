// Map a free-text holding.grade ("PSA 10", "CGC 9.5", "BGS 9", "NM",
// "RAW", null, ...) to the bucket vocabulary used by `card_metrics`,
// `variant_metrics`, and the surfacing layer (RAW, LE_7, G8, G9, G9_5,
// G10, G10_PERFECT).
//
// Used by /api/holdings/summary and /api/portfolio/overview to value
// graded holdings at the graded market price instead of falling back
// to the slug's RAW price (which was the latent bug Phase 2 fixes).
//
// Mirrors the script-side helper in scripts/report-graded-pricing-coverage.mjs
// so coverage reports and live valuation use the same translation.

export type GradeBucket = "RAW" | "LE_7" | "G8" | "G9" | "G9_5" | "G10" | "G10_PERFECT";

const RAW_CONDITION_PREFIXES = ["NM", "LP", "MP", "HP", "DMG"];

export function normalizeHoldingGrade(rawGrade: string | null | undefined): GradeBucket {
  if (rawGrade == null) return "RAW";
  const trimmed = String(rawGrade).trim();
  if (trimmed === "") return "RAW";

  const upper = trimmed.toUpperCase();
  if (upper === "RAW") return "RAW";
  // Condition-level grades (NM/LP/MP/HP/DMG) all live under the RAW pricing
  // tier — card_metrics doesn't differentiate condition; condition pricing
  // surfaces separately via card_condition_prices.
  for (const prefix of RAW_CONDITION_PREFIXES) {
    if (upper.startsWith(prefix)) return "RAW";
  }

  // Provider-prefixed numeric grades: "PSA 10", "CGC 9.5", "BGS 9".
  // Pull the first numeric token; everything else is metadata we don't need
  // for bucket resolution (provider distinction lives in variant_metrics, not
  // card_metrics, so per-bucket aggregate is the right resolution here).
  const match = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (!match) return "RAW";

  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n)) return "RAW";

  // Match the same boundaries used by Scrydex graded extraction
  // (lib/backfill/scrydex-raw-price-select.ts SCRYDEX_GRADE_MAP):
  //   1–7.5 → LE_7, 8–8.5 → G8/G9 (8.5 rounds up), 9 → G9, 9.5 → G9_5,
  //   10 → G10, "Perfect 10" → G10_PERFECT (handled below for explicit
  //   PERFECT/BLACK strings).
  const isPerfect = /\b(PERFECT|BLACK[-\s]?LABEL)\b/i.test(trimmed);
  if (n >= 10) return isPerfect ? "G10_PERFECT" : "G10";
  if (n >= 9.5) return "G9_5";
  if (n >= 9) return "G9";
  if (n >= 8) return "G8";
  return "LE_7";
}

export function isGradedBucket(bucket: string): boolean {
  return bucket !== "RAW";
}
