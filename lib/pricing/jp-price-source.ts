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
 *     default Market Price.
 *
 * Lives in lib/pricing/ alongside displayed-market-price.ts since it's
 * the same family of "pick the right price to render" helpers.
 */

export type JpPriceSourceKind = "snkrdunk" | "yahoo_jp" | null;

export type JpPriceSource = {
  source: JpPriceSourceKind;
  price: number | null;
  /**
   * Native JPY value for the picked source, when available. Yahoo! JP
   * captures this directly at observation time (`yahoo_jp_price_jpy`).
   * Snkrdunk currently has no native JPY analog — its English API
   * returns USD only — so the snkrdunk path leaves this null until a
   * follow-up adds either a native scrape or a view-time FX
   * computation. Renderers should display "¥X,XXX ($X)" when
   * priceJpy is non-null and fall back to "$X" otherwise.
   */
  priceJpy: number | null;
  sampleCount: number | null;
  /**
   * Short label suitable for a tile-corner pill. Empty when source is null.
   */
  label: string;
};

/**
 * Snkrdunk has no native JPY observation — its English API returns USD
 * only, and the `snkrdunk_price_jpy` column is back-computed from that
 * USD via an FX rate at write time. Rendering that derived number as
 * "¥3,200" presents fabricated precision as a JP-market quote, so the
 * picker refuses to emit it: the snkrdunk path always returns
 * `priceJpy: null` and renderers fall back to the true USD value. If a
 * native Snkrdunk JPY scrape ships later, lift this here (one place)
 * rather than per-surface.
 */

const MIN_SAMPLE_FOR_TILE = 3;

export function selectJpPriceSource(input: {
  yahooJpPrice: number | null | undefined;
  yahooJpPriceJpy?: number | null | undefined;
  yahooJpSampleCount: number | null | undefined;
  snkrdunkPrice: number | null | undefined;
  snkrdunkPriceJpy?: number | null | undefined;
  snkrdunkSampleCount: number | null | undefined;
}): JpPriceSource {
  const yj = typeof input.yahooJpPrice === "number" && input.yahooJpPrice > 0
    ? input.yahooJpPrice
    : 0;
  const yjJpy = typeof input.yahooJpPriceJpy === "number" && input.yahooJpPriceJpy > 0
    ? input.yahooJpPriceJpy
    : null;
  const snk = typeof input.snkrdunkPrice === "number" && input.snkrdunkPrice > 0
    ? input.snkrdunkPrice
    : 0;
  // FX-derived, not a real listed yen price — never displayed (see note
  // on the type above). The parameter stays accepted so call sites don't
  // churn when a native scrape lands.
  const snkJpy: number | null = null;
  void input.snkrdunkPriceJpy;
  const yjN = typeof input.yahooJpSampleCount === "number"
    ? input.yahooJpSampleCount
    : 0;
  const snkN = typeof input.snkrdunkSampleCount === "number"
    ? input.snkrdunkSampleCount
    : 0;

  // Require a minimum sample count before promoting a JP source onto a
  // tile. Single-sale medians are too noisy to surface alongside
  // the default USD market anchor.
  const yjQualifies = yj > 0 && yjN >= MIN_SAMPLE_FOR_TILE;
  const snkQualifies = snk > 0 && snkN >= MIN_SAMPLE_FOR_TILE;

  if (yjQualifies && snkQualifies) {
    // Both qualified — pick the one with more sample sales.
    return snkN > yjN
      ? { source: "snkrdunk", price: snk, priceJpy: snkJpy, sampleCount: snkN, label: "Snkrdunk" }
      : { source: "yahoo_jp", price: yj, priceJpy: yjJpy, sampleCount: yjN, label: "Yahoo! JP" };
  }
  if (snkQualifies) {
    return { source: "snkrdunk", price: snk, priceJpy: snkJpy, sampleCount: snkN, label: "Snkrdunk" };
  }
  if (yjQualifies) {
    return { source: "yahoo_jp", price: yj, priceJpy: yjJpy, sampleCount: yjN, label: "Yahoo! JP" };
  }
  return { source: null, price: null, priceJpy: null, sampleCount: null, label: "" };
}

/**
 * Format a JP price for display. When native JPY is available we lead
 * with the yen value and parenthesize the USD ("¥3,200 ($21)") so the
 * user reads the price as a JP-market price first. Falls back to
 * USD-only when JPY is absent.
 */
export function formatJpSourcePriceLabel(source: JpPriceSource): string {
  if (source.price == null || source.price <= 0) return "--";
  const usd = `$${source.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (source.priceJpy == null || source.priceJpy <= 0) return usd;
  // Yen has no decimal point in everyday use; show the integer value.
  const jpy = `¥${Math.round(source.priceJpy).toLocaleString()}`;
  return `${jpy} (${usd})`;
}
