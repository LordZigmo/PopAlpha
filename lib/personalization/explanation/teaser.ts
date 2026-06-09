import type { CollectorInsight } from "../types";

/**
 * The ONLY CollectorInsight fields a non-Pro actor may receive. The
 * paywall's locked preview shows fit label + score, collector type, the
 * summary lead, and confidence; everything else (roleInCollection,
 * tradeoff, bestMove, popAlphaRead, dataBasis, provenance) is paid
 * depth and must never appear in a teaser response.
 *
 * tests/personalization/teaser-contract.test.mjs locks this contract —
 * if you add a field here, you are intentionally moving it to the free
 * tier.
 */
export const COLLECTOR_INSIGHT_TEASER_KEYS = [
  "fitLabel",
  "fitScore",
  "collectorType",
  "summary",
  "confidence",
  "source",
] as const;

export type CollectorInsightTeaser = Pick<
  CollectorInsight,
  (typeof COLLECTOR_INSIGHT_TEASER_KEYS)[number]
>;

/**
 * Pick-list projection from a full CollectorInsight to the free-tier
 * teaser. Deliberately field-by-field — never spread the full object,
 * or a future CollectorInsight field would leak to free users by
 * default.
 */
export function toCollectorInsightTeaser(full: CollectorInsight): CollectorInsightTeaser {
  return {
    fitLabel: full.fitLabel,
    fitScore: full.fitScore,
    collectorType: full.collectorType,
    summary: full.summary,
    confidence: full.confidence,
    source: "template",
  };
}
