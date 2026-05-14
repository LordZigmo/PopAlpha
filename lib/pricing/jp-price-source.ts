/**
 * Confidence-pick between Yahoo! Auctions JP and Snkrdunk price sources
 * for tile-level rendering. Matches the same selection logic used by
 * iOS's CardDetailView (PR #51 — preferredHeroPrice + heroPriceSourceLabel)
 * so the web tiles and the iOS hero tell a coherent per-source story.
 *
 * Rule:
 *   - If both sources have a price > 0, prefer the one with more sample
 *     sales (its median is more stable).
 *   - If only one source has data, use that one.
 *   - If neither has data, return null source — tile falls back to the
 *     Scrydex market_price.
 *
 * Lives in lib/pricing/ alongside displayed-market-price.ts since it's
 * the same family of "pick the right price to render" helpers.
 */

export type JpPriceSourceKind = "snkrdunk" | "yahoo_jp" | null;

export type JpPriceSource = {
  source: JpPriceSourceKind;
  price: number | null;
  sampleCount: number | null;
  /**
   * Short label suitable for a tile-corner pill. Empty when source is null.
   */
  label: string;
};

const MIN_SAMPLE_FOR_TILE = 3;

export function selectJpPriceSource(input: {
  yahooJpPrice: number | null | undefined;
  yahooJpSampleCount: number | null | undefined;
  snkrdunkPrice: number | null | undefined;
  snkrdunkSampleCount: number | null | undefined;
}): JpPriceSource {
  const yj = typeof input.yahooJpPrice === "number" && input.yahooJpPrice > 0
    ? input.yahooJpPrice
    : 0;
  const snk = typeof input.snkrdunkPrice === "number" && input.snkrdunkPrice > 0
    ? input.snkrdunkPrice
    : 0;
  const yjN = typeof input.yahooJpSampleCount === "number"
    ? input.yahooJpSampleCount
    : 0;
  const snkN = typeof input.snkrdunkSampleCount === "number"
    ? input.snkrdunkSampleCount
    : 0;

  // Require a minimum sample count before promoting a JP source onto a
  // tile. Single-sale medians are too noisy to surface alongside
  // Scrydex's typically multi-day rolling price.
  const yjQualifies = yj > 0 && yjN >= MIN_SAMPLE_FOR_TILE;
  const snkQualifies = snk > 0 && snkN >= MIN_SAMPLE_FOR_TILE;

  if (yjQualifies && snkQualifies) {
    // Both qualified — pick the one with more sample sales.
    return snkN > yjN
      ? { source: "snkrdunk", price: snk, sampleCount: snkN, label: "Snkrdunk" }
      : { source: "yahoo_jp", price: yj, sampleCount: yjN, label: "Yahoo! JP" };
  }
  if (snkQualifies) {
    return { source: "snkrdunk", price: snk, sampleCount: snkN, label: "Snkrdunk" };
  }
  if (yjQualifies) {
    return { source: "yahoo_jp", price: yj, sampleCount: yjN, label: "Yahoo! JP" };
  }
  return { source: null, price: null, sampleCount: null, label: "" };
}
