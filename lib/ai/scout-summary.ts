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
  activeListings7d,
}: PopAlphaScoutSummaryInput): PopAlphaScoutSummary {
  const priceText = formatUsd(marketPrice);
  const fairValueText = fairValue !== null ? formatUsd(fairValue) : null;
  const changeText = formatSignedPct(changePct);

  let openingLine = `${cardName} is trading around ${priceText}.`;
  if (changeText && changeLabel) {
    openingLine = changePct! > 0
      ? `${cardName} is trading around ${priceText}, up ${changeText} over the last ${changeLabel}.`
      : changePct! < 0
        ? `${cardName} is trading around ${priceText}, pulling back ${changeText} over the last ${changeLabel}.`
        : `${cardName} is trading around ${priceText}, holding flat over the last ${changeLabel}.`;
  }

  let valueLine = "";
  if (marketPrice !== null && fairValue !== null && fairValue > 0) {
    const edgePct = ((marketPrice - fairValue) / fairValue) * 100;
    if (edgePct <= -1) {
      valueLine = ` That sits below fair value near ${fairValueText}, which could make it a solid entry point.`;
    } else if (edgePct >= 1) {
      valueLine = ` That is above fair value near ${fairValueText}, so buyers are paying a premium right now.`;
    } else {
      valueLine = ` That lines up closely with fair value near ${fairValueText}.`;
    }
  }

  let supplyLine = "";
  if (activeListings7d !== null) {
    if (activeListings7d <= 4) {
      supplyLine = ` Supply is limited with only ${activeListings7d} listings in the last 7 days.`;
    } else {
      supplyLine = ` There were ${activeListings7d} listings over the last 7 days, so supply is steady.`;
    }
  }

  return {
    summaryShort: openingLine,
    summaryLong: `${openingLine} ${valueLine} ${supplyLine}`,
  };
}
