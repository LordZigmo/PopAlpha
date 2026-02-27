type IntelligenceInput = {
  totalPop: number | null;
  populationHigher: number | null;
  scarcityScore: number | null;
  liquidityTier: string | null;
};

function hasNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function formatPercent(value: number): string {
  if (Number.isInteger(value)) return `${value}%`;
  return `${value.toFixed(1)}%`;
}

export function generateIntelligenceSummary({
  totalPop,
  populationHigher,
  scarcityScore,
  liquidityTier,
}: IntelligenceInput): string {
  const sentences: string[] = [];
  const validTotals = hasNumber(totalPop) && totalPop > 0;
  const validHigher = hasNumber(populationHigher) && populationHigher >= 0;
  const percentHigher = validTotals && validHigher ? (populationHigher / totalPop) * 100 : null;

  if (validHigher && populationHigher === 0) {
    sentences.push("This grade sits at the top of the population with no higher examples recorded.");
  } else if (percentHigher !== null) {
    if (percentHigher < 5) {
      sentences.push(`Only ${formatPercent(percentHigher)} of graded copies sit higher, placing this in a top percentile band.`);
    } else if (percentHigher < 20) {
      sentences.push(`${formatPercent(percentHigher)} of graded copies are higher, positioning this in an upper-tier range.`);
    } else if (percentHigher < 50) {
      sentences.push(`${formatPercent(percentHigher)} of graded copies are higher, indicating a mid-to-upper distribution.`);
    } else {
      sentences.push(`${formatPercent(percentHigher)} of graded copies are higher, which points to a more common grade tier.`);
    }
  }

  if (validTotals) {
    if (totalPop === 1) {
      sentences.push("With a population of one, valuation is entirely demand-driven.");
    } else if (totalPop < 50) {
      sentences.push("Low population suggests constrained supply.");
    } else if (totalPop < 1000) {
      sentences.push("Population remains relatively tight, supporting scarcity-aware pricing.");
    } else {
      sentences.push("Population depth supports more frequent market turnover.");
    }
  } else if (hasNumber(scarcityScore)) {
    sentences.push(`Scarcity reads ${Math.round(scarcityScore)}/100, offering directional context despite incomplete population data.`);
  } else {
    sentences.push("Population coverage is limited, so this read should be treated as preliminary.");
  }

  if (liquidityTier) {
    sentences.push(`Liquidity signal: ${liquidityTier}.`);
  }

  return sentences.slice(0, 4).join(" ");
}

