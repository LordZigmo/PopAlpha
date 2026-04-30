export type PopAlphaScoutSummaryInput = {
  cardName: string;
  marketPrice: number | null;
  fairValue: number | null;
  changePct: number | null;
  changeLabel: "24h" | "7d" | null;
  // Rolled-up price-observation count over 7 days (DB column:
  // active_listings_7d). The raw number is summed across printing
  // variants and dominated by data-provider rows, so the absolute
  // count is meaningless to a collector. The fallback below translates
  // it to a qualitative bucket (thin/steady/dense) and never surfaces
  // the raw number. NOT marketplace listings or copies for sale.
  priceObservations7d: number | null;
};

export type PopAlphaScoutSummary = {
  summaryShort: string;
  summaryLong: string;
};

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "an unpriced level";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatSignedPct(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
}

export function buildPopAlphaScoutSummary({
  cardName,
  marketPrice,
  fairValue,
  changePct,
  changeLabel,
  priceObservations7d,
}: PopAlphaScoutSummaryInput): PopAlphaScoutSummary {
  const priceText = formatUsd(marketPrice);
  const fairValueText = fairValue !== null ? formatUsd(fairValue) : null;
  const changeText = formatSignedPct(changePct);

  // Sentence 1 — what is happening
  let happeningLine = `${cardName} is trading around ${priceText}.`;
  if (changeText && changeLabel) {
    if (changePct != null && changePct > 0) {
      happeningLine = `${cardName} is up ${changeText} over the last ${changeLabel}, trading around ${priceText}.`;
    } else if (changePct != null && changePct < 0) {
      happeningLine = `${cardName} is down ${changeText} over the last ${changeLabel}, trading around ${priceText}.`;
    } else {
      happeningLine = `${cardName} is holding flat over the last ${changeLabel}, trading around ${priceText}.`;
    }
  }

  // Sentence 2 — why it matters (vs. fair value)
  let mattersLine = "";
  if (marketPrice !== null && fairValue !== null && fairValue > 0) {
    const edgePct = ((marketPrice - fairValue) / fairValue) * 100;
    if (edgePct <= -1) {
      mattersLine = ` That is below fair value near ${fairValueText}, so it could be a good buying range.`;
    } else if (edgePct >= 1) {
      mattersLine = ` That is above fair value near ${fairValueText}, so buyers are paying a small premium right now.`;
    } else {
      mattersLine = ` That lines up with fair value near ${fairValueText}.`;
    }
  }

  // Sentence 3 — what to watch next. The raw priceObservations7d count is
  // rolled up across printing variants and dominated by data-provider rows,
  // so it's meaningless to a collector. Translate to a qualitative bucket
  // (thin/steady/dense) and never show the raw number.
  let watchLine = "";
  if (priceObservations7d !== null) {
    if (priceObservations7d <= 4) {
      watchLine = " Price tracking on this card is thin, so the next sale will tell you a lot.";
    } else if (priceObservations7d < 30) {
      watchLine = " Price tracking is steady — watch whether the price holds across the next few sales.";
    } else {
      watchLine = " Price tracking is dense, so a clean move shows up fast — watch whether it holds across the next few sales.";
    }
  }

  return {
    summaryShort: happeningLine,
    summaryLong: `${happeningLine}${mattersLine}${watchLine}`,
  };
}
