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

  let openingLine = `Okay, so ${cardName} is trading around ${priceText}, which is kind of wild if you have been watching this one.`;
  if (changeText && changeLabel) {
    openingLine = changePct! > 0
      ? `Okay, so ${cardName} is trading around ${priceText}, and it is up ${changeText} over the last ${changeLabel}, which is making it feel pretty lively.`
      : changePct! < 0
        ? `Okay, so ${cardName} is trading around ${priceText}, after a ${changeText} move over the last ${changeLabel}, so the market cooled off a bit.`
        : `Okay, so ${cardName} is trading around ${priceText}, and it has been basically flat over the last ${changeLabel}.`;
  }

  let valueLine = "I am still waiting on enough fair-value data to really map this one out.";
  if (marketPrice !== null && fairValue !== null && fairValue > 0) {
    const edgePct = ((marketPrice - fairValue) / fairValue) * 100;
    if (edgePct <= -1) {
      valueLine = `By my notes, that is below our fair value mark near ${fairValueText}, so this might actually be a pretty nice pickup for the binder.`;
    } else if (edgePct >= 1) {
      valueLine = `By my notes, that is above our fair value mark near ${fairValueText}, so people are definitely paying extra for it right now.`;
    } else {
      valueLine = `By my notes, that is almost exactly on top of our fair value mark near ${fairValueText}, which is honestly weirdly tidy.`;
    }
  }

  let supplyLine = "Supply is still kind of fuzzy from here.";
  if (activeListings7d !== null) {
    if (activeListings7d <= 4) {
      supplyLine = `There were only ${activeListings7d} live listings over the last 7 days, so supply looks pretty tight for a chase like this.`;
    } else {
      supplyLine = `There were ${activeListings7d} live listings over the last 7 days, so there is enough on the board that you do not have to panic-buy it.`;
    }
  }

  return {
    summaryShort: openingLine,
    summaryLong: `${openingLine} ${valueLine} ${supplyLine}`,
  };
}
