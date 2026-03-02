export type LiquidityTier = "Illiquid" | "Thin" | "Active" | "Highly Liquid";

export type LiquidityInput = {
  priceChanges30d: number | null;
  snapshotCount30d: number | null;
  low30d: number | null;
  high30d: number | null;
  median30d: number | null;
};

export type LiquidityResult = {
  score: number;
  tier: LiquidityTier;
  tone: "warning" | "neutral" | "positive";
  velocityPts: number;
  densityPts: number;
  spreadPts: number;
  spreadPercent: number | null;
};

export function getLiquidityTier(score: number): LiquidityTier {
  if (score >= 76) return "Highly Liquid";
  if (score >= 51) return "Active";
  if (score >= 26) return "Thin";
  return "Illiquid";
}

export function getLiquidityTone(score: number): "warning" | "neutral" | "positive" {
  if (score >= 76) return "positive";
  if (score <= 25) return "warning";
  return "neutral";
}

export function computeLiquidity(input: LiquidityInput): LiquidityResult | null {
  const { priceChanges30d, snapshotCount30d, low30d, high30d, median30d } = input;

  // Need at least one non-null metric to compute anything useful
  const hasAny =
    (priceChanges30d !== null && priceChanges30d > 0) ||
    (snapshotCount30d !== null && snapshotCount30d > 0) ||
    (median30d !== null && median30d > 0);

  if (!hasAny) return null;

  // Velocity: 40 pts — 50+ price changes in 30d = full marks
  const velocity = priceChanges30d !== null && priceChanges30d >= 0
    ? Math.min(priceChanges30d / 50, 1) * 40
    : 0;

  // Density: 30 pts — daily snapshot = full marks
  const density = snapshotCount30d !== null && snapshotCount30d >= 0
    ? Math.min(snapshotCount30d / 30, 1) * 30
    : 0;

  // Spread tightness: 30 pts — spread >= 50% of median = 0 pts
  let spread: number | null = null;
  let spreadPts = 0;
  if (
    low30d !== null && high30d !== null && median30d !== null &&
    median30d > 0 && high30d >= low30d
  ) {
    spread = (high30d - low30d) / median30d;
    spreadPts = Math.max(0, 1 - spread / 0.5) * 30;
  }

  const score = Math.round(velocity + density + spreadPts);
  const clamped = Math.max(0, Math.min(100, score));

  return {
    score: clamped,
    tier: getLiquidityTier(clamped),
    tone: getLiquidityTone(clamped),
    velocityPts: Math.round(velocity * 10) / 10,
    densityPts: Math.round(density * 10) / 10,
    spreadPts: Math.round(spreadPts * 10) / 10,
    spreadPercent: spread !== null ? Math.round(spread * 1000) / 10 : null,
  };
}
