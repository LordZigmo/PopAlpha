import { computeVariantSignals } from "@/lib/signals/scoring";

export type MarketDirection = "bullish" | "bearish" | "flat";

type MarketStrengthInputs = {
  trendSlope7d: number | null | undefined;
  covPrice30d: number | null | undefined;
  priceRelativeTo30dRange: number | null | undefined;
  priceChangesCount30d: number | null | undefined;
  latestPrice: number | null | undefined;
  snapshotCount30d: number | null | undefined;
  confidenceScore: number | null | undefined;
  lowConfidence: boolean | null | undefined;
  liquidityScore: number | null | undefined;
  activeListings7d: number | null | undefined;
  changePct24h: number | null | undefined;
  changePct7d: number | null | undefined;
};

export type MarketStrengthResult = {
  marketStrengthScore: number | null;
  marketDirection: MarketDirection | null;
  signalTrend: number | null;
  signalBreakout: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeLiquidityScore(
  liquidityScore: number | null | undefined,
  activeListings7d: number | null | undefined,
): number | null {
  const normalizedLiquidityScore = toFiniteNumber(liquidityScore);
  if (normalizedLiquidityScore !== null) {
    return clamp(normalizedLiquidityScore, 0, 100);
  }

  const listings = toFiniteNumber(activeListings7d);
  if (listings === null) return null;
  if (listings <= 1) return 20;
  if (listings <= 3) return 35;
  if (listings <= 5) return 50;
  if (listings <= 10) return 70;
  if (listings <= 20) return 85;
  return 100;
}

function deriveDirection(
  changePct24h: number | null | undefined,
  changePct7d: number | null | undefined,
  signalTrend: number | null,
): MarketDirection | null {
  const dayMove = toFiniteNumber(changePct24h);
  if (dayMove !== null && Math.abs(dayMove) >= 0.15) {
    return dayMove > 0 ? "bullish" : "bearish";
  }

  const weekMove = toFiniteNumber(changePct7d);
  if (weekMove !== null && Math.abs(weekMove) >= 0.35) {
    return weekMove > 0 ? "bullish" : "bearish";
  }

  if (signalTrend !== null) {
    if (signalTrend >= 55) return "bullish";
    if (signalTrend <= 45) return "bearish";
    return "flat";
  }

  return null;
}

export function computeCanonicalMarketStrength(
  inputs: MarketStrengthInputs,
): MarketStrengthResult {
  const latestPrice = toFiniteNumber(inputs.latestPrice);
  const confidenceScore = toFiniteNumber(inputs.confidenceScore);
  const snapshotCount30d = toFiniteNumber(inputs.snapshotCount30d);
  const liquidity = normalizeLiquidityScore(inputs.liquidityScore, inputs.activeListings7d);

  const { signal_trend: signalTrend, signal_breakout: signalBreakout } = computeVariantSignals({
    trendSlope7d: toFiniteNumber(inputs.trendSlope7d),
    covPrice30d: toFiniteNumber(inputs.covPrice30d),
    priceRelativeTo30dRange: toFiniteNumber(inputs.priceRelativeTo30dRange),
    priceChangesCount30d: toFiniteNumber(inputs.priceChangesCount30d),
    latestPrice,
    samplePoints: snapshotCount30d ?? 0,
  });

  const marketDirection = latestPrice === null
    ? null
    : deriveDirection(
        inputs.changePct24h,
        inputs.changePct7d,
        signalTrend,
      );

  if (
    latestPrice === null
    || inputs.lowConfidence === true
    || confidenceScore === null
    || confidenceScore < 45
    || liquidity === null
    || signalTrend === null
    || signalBreakout === null
  ) {
    return {
      marketStrengthScore: null,
      marketDirection,
      signalTrend,
      signalBreakout,
    };
  }

  const trendStrength = clamp(Math.abs(signalTrend - 50) * 2, 0, 100);
  const score = Math.round(
    (trendStrength * 0.5)
    + (signalBreakout * 0.2)
    + (confidenceScore * 0.2)
    + (liquidity * 0.1),
  );

  return {
    marketStrengthScore: clamp(score, 0, 100),
    marketDirection,
    signalTrend,
    signalBreakout,
  };
}
