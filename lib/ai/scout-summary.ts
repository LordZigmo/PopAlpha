export type PopAlphaScoutSummaryInput = {
  cardName: string;
  marketPrice: number | null;
  fairValue: number | null;
  changePct: number | null;
  changeLabel: "24h" | "7d" | null;
  activeListings7d: number | null;
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

function formatPct(value: number | null, options: { absolute?: boolean } = {}): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  if (options.absolute) return `${formatted}%`;
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
}

export function buildPopAlphaScoutSummary({
  cardName,
  marketPrice,
  fairValue,
  changePct,
  changeLabel,
  activeListings7d,
}: PopAlphaScoutSummaryInput): PopAlphaScoutSummary {
  const priceText = formatUsd(marketPrice);
  const fairValueText = fairValue !== null ? formatUsd(fairValue) : null;
  const signedChangeText = formatPct(changePct);
  const absoluteChangeText = formatPct(changePct, { absolute: true });

  let openingLine = `${cardName} is trading near ${priceText}.`;
  if (absoluteChangeText && changeLabel) {
    openingLine = changePct! > 0
      ? `${cardName} is trading near ${priceText}, up ${absoluteChangeText} over the last ${changeLabel}.`
      : changePct! < 0
        ? `${cardName} is trading near ${priceText}, down ${absoluteChangeText} over the last ${changeLabel}.`
        : `${cardName} is trading near ${priceText}, flat over the last ${changeLabel}.`;
  }

  let valueLine = "Fair value is still forming, so price discovery matters more than mean reversion right now.";
  if (marketPrice !== null && fairValue !== null && fairValue > 0) {
    const edgePct = ((marketPrice - fairValue) / fairValue) * 100;
    if (edgePct <= -1) {
      valueLine = `That sits below our fair value near ${fairValueText}, which puts it back into a potential value zone if demand holds.`;
    } else if (edgePct >= 1) {
      valueLine = `That sits above our fair value near ${fairValueText}, so buyers are still paying a premium to get exposure here.`;
    } else {
      valueLine = `That is sitting almost exactly on top of our fair value near ${fairValueText}, so the signal is coming more from momentum than from mispricing.`;
    }
  }

  let supplyLine = "Supply depth is still thin, so the next listing cycle matters.";
  if (activeListings7d !== null) {
    if (activeListings7d <= 4) {
      supplyLine = `Supply looks tight with only ${activeListings7d} active listings over the last 7 days, so fresh demand can still move this quickly.`;
    } else if (activeListings7d <= 10) {
      supplyLine = `Supply is active with ${activeListings7d} listings over the last 7 days, which gives buyers room without forcing panic pricing.`;
    } else {
      supplyLine = `Supply is deeper with ${activeListings7d} listings over the last 7 days, so the move will need steady demand to keep extending.`;
    }
  }

  return {
    summaryShort: signedChangeText && changeLabel
      ? `${cardName} is trading near ${priceText}, ${signedChangeText} over the last ${changeLabel}.`
      : openingLine,
    summaryLong: `${openingLine} ${valueLine} ${supplyLine}`,
  };
}
