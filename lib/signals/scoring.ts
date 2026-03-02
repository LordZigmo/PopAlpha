export type VariantSignalInputs = {
  trendSlope7d: number | null;
  covPrice30d: number | null;
  priceRelativeTo30dRange: number | null;
  priceChangesCount30d: number | null;
  latestPrice: number | null;
  samplePoints: number;
};

export type VariantSignalScores = {
  signal_trend: number | null;
  signal_breakout: number | null;
  signal_value: number | null;
};

const SIGNAL_MIN_POINTS = 10;
const SIGNAL_CONFIDENCE_CAP = 45;
const ACTIVITY_CAP = 12;
const MIN_PRICE_FLOOR = 0.25;
const MIN_COV_FLOOR = 0.08;
const VALUE_PRICE_CAP = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function squashCentered(raw: number): number {
  return clamp(50 + 50 * Math.tanh(raw), 0, 100);
}

function squashPositive(raw: number): number {
  return clamp(100 * Math.tanh(Math.max(raw, 0)), 0, 100);
}

export function signalSampleConfidence(samplePoints: number): number {
  const bounded = clamp(samplePoints, 0, SIGNAL_CONFIDENCE_CAP);
  if (bounded === 0) return 0;
  return Math.sqrt(bounded / SIGNAL_CONFIDENCE_CAP);
}

export function signalActivityScore(priceChangesCount30d: number | null): number {
  const changes = clamp(Math.max(priceChangesCount30d ?? 0, 0), 0, ACTIVITY_CAP);
  return Math.log1p(changes) / Math.log1p(ACTIVITY_CAP);
}

export function normalizeRangePosition(priceRelativeTo30dRange: number | null): number | null {
  if (priceRelativeTo30dRange === null || !Number.isFinite(priceRelativeTo30dRange)) return null;
  return clamp(priceRelativeTo30dRange, 0, 1);
}

export function computeVariantSignals(inputs: VariantSignalInputs): VariantSignalScores {
  const {
    trendSlope7d,
    covPrice30d,
    priceRelativeTo30dRange,
    priceChangesCount30d,
    latestPrice,
    samplePoints,
  } = inputs;

  if (!Number.isFinite(samplePoints) || samplePoints < SIGNAL_MIN_POINTS) {
    return {
      signal_trend: null,
      signal_breakout: null,
      signal_value: null,
    };
  }

  const sampleConfidence = signalSampleConfidence(samplePoints);
  const activityScore = signalActivityScore(priceChangesCount30d);
  const rangePosition = normalizeRangePosition(priceRelativeTo30dRange);
  const priceAnchor = Math.max(latestPrice ?? 0, MIN_PRICE_FLOOR);
  const volatilityAnchor = Math.max(covPrice30d ?? 0, MIN_COV_FLOOR);

  let signal_trend: number | null = null;
  let normalizedMomentum = 0;
  if (
    trendSlope7d !== null
    && Number.isFinite(trendSlope7d)
    && covPrice30d !== null
    && Number.isFinite(covPrice30d)
  ) {
    normalizedMomentum = (trendSlope7d / priceAnchor) / volatilityAnchor;
    const trendRaw = normalizedMomentum * 6 * sampleConfidence;
    signal_trend = roundTo(squashCentered(trendRaw), 1);
  }

  let signal_breakout: number | null = null;
  if (
    trendSlope7d !== null
    && Number.isFinite(trendSlope7d)
    && rangePosition !== null
  ) {
    const roomToRun = 1 - rangePosition;
    const breakoutRaw =
      Math.max(normalizedMomentum, 0)
      * (0.55 + 0.45 * activityScore)
      * (0.5 + 0.5 * sampleConfidence)
      * roomToRun
      * 2.8;
    signal_breakout = roundTo(squashPositive(breakoutRaw), 1);
  }

  let signal_value: number | null = null;
  if (rangePosition !== null) {
    const discountToRange = Math.pow(1 - rangePosition, 1.15);
    const priceQuality = Math.sqrt(clamp(priceAnchor / VALUE_PRICE_CAP, 0, 1));
    const valueRaw =
      discountToRange
      * (0.35 + 0.65 * sampleConfidence)
      * (0.25 + 0.75 * activityScore)
      * priceQuality;
    signal_value = roundTo(clamp(valueRaw * 100, 0, 100), 1);
  }

  return {
    signal_trend,
    signal_breakout,
    signal_value,
  };
}

export function trendSignalLabel(score: number): string {
  if (score < 35) return "Weakening";
  if (score < 45) return "Soft";
  if (score < 55) return "Stable";
  if (score < 70) return "Improving";
  return "Strong";
}

export function breakoutSignalLabel(score: number): string {
  if (score < 20) return "Quiet";
  if (score < 40) return "Watching";
  if (score < 60) return "Building";
  if (score < 80) return "Active";
  return "Breaking Out";
}

export function valueSignalLabel(score: number): string {
  if (score < 20) return "Extended";
  if (score < 40) return "Rich";
  if (score < 60) return "Fair";
  if (score < 80) return "Discounted";
  return "Compelling";
}
