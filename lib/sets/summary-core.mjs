function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function buildSetId(setName) {
  const normalized = String(setName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

export function choosePrimaryVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;

  const scored = variants
    .filter((variant) => variant && typeof variant === "object")
    .map((variant) => {
      const finish = String(variant.finish ?? "UNKNOWN").toUpperCase();
      const observationCount30d = Number(variant.observationCount30d ?? 0);
      const latestObservedAt = variant.latestObservedAt ? new Date(variant.latestObservedAt).getTime() : 0;
      const latestPrice = Number(variant.latestPrice ?? 0);

      return {
        variant,
        finishScore: finish === "NON_HOLO" ? 0 : 1,
        observationCount30d,
        latestObservedAt,
        latestPrice,
      };
    });

  if (scored.length === 0) return null;

  scored.sort((left, right) => {
    if (left.finishScore !== right.finishScore) return left.finishScore - right.finishScore;
    if (left.observationCount30d !== right.observationCount30d) {
      return right.observationCount30d - left.observationCount30d;
    }
    if (left.latestObservedAt !== right.latestObservedAt) {
      return right.latestObservedAt - left.latestObservedAt;
    }
    if (left.latestPrice !== right.latestPrice) return right.latestPrice - left.latestPrice;
    return String(left.variant.variantRef ?? "").localeCompare(String(right.variant.variantRef ?? ""));
  });

  return scored[0]?.variant ?? null;
}

export function computeHeatScore(input) {
  const avgAbsChange7d = Number(input?.avgAbsChange7d ?? 0);
  const avgActivity30d = Number(input?.avgActivity30d ?? 0);
  const breakoutCount = Number(input?.breakoutCount ?? 0);
  const primaryCardCount = Number(input?.primaryCardCount ?? 0);
  const breakoutDensity = primaryCardCount > 0 ? breakoutCount / primaryCardCount : 0;

  return roundTo(
    avgAbsChange7d * 0.6
      + (Math.min(Math.max(avgActivity30d, 0), 30) / 30) * 25
      + breakoutDensity * 15,
    2,
  );
}

export function aggregatePrimaryVariantStats(cards) {
  const primaryVariants = [];

  for (const card of Array.isArray(cards) ? cards : []) {
    const primary = choosePrimaryVariant(card?.variants ?? []);
    if (primary) primaryVariants.push(primary);
  }

  const marketCap = primaryVariants.reduce((sum, variant) => sum + Number(variant.latestPrice ?? 0), 0);
  const marketCap7d = primaryVariants.reduce((sum, variant) => sum + Number(variant.price7d ?? 0), 0);
  const marketCap30d = primaryVariants.reduce((sum, variant) => sum + Number(variant.price30d ?? 0), 0);
  const breakoutCount = primaryVariants.filter((variant) => Number(variant.signalBreakout ?? 0) >= 70).length;
  const valueZoneCount = primaryVariants.filter((variant) => Number(variant.signalValue ?? 0) >= 70).length;
  const trendBullishCount = primaryVariants.filter((variant) => Number(variant.signalTrend ?? 0) >= 60).length;
  const changes = primaryVariants
    .map((variant) => Number(variant.change7dPct))
    .filter((value) => Number.isFinite(value));
  const avgAbsChange7d = changes.length
    ? changes.reduce((sum, value) => sum + Math.abs(value), 0) / changes.length
    : 0;
  const avgActivity30d = primaryVariants.length
    ? primaryVariants.reduce((sum, variant) => sum + Math.min(Math.max(Number(variant.observationCount30d ?? 0), 0), 30), 0) / primaryVariants.length
    : 0;

  return {
    primaryVariants,
    marketCap: roundTo(marketCap, 2),
    marketCap7d: roundTo(marketCap7d, 2),
    marketCap30d: roundTo(marketCap30d, 2),
    breakoutCount,
    valueZoneCount,
    trendBullishCount,
    heatScore: computeHeatScore({
      avgAbsChange7d,
      avgActivity30d,
      breakoutCount,
      primaryCardCount: primaryVariants.length,
    }),
  };
}
