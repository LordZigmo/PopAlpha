export type SnapshotTrustRow = {
  market_price: number | null;
  market_confidence_score?: number | null;
  market_low_confidence?: boolean | null;
  market_blend_policy?: string | null;
};

export type SnapshotTrustFallback = {
  confidenceScore: number;
  lowConfidence: boolean;
  blendPolicy: string;
};

export function resolveSnapshotTrust(
  row: SnapshotTrustRow | null,
  fallback: SnapshotTrustFallback,
): SnapshotTrustFallback {
  const marketPrice = row?.market_price ?? null;
  if (marketPrice === null) {
    return {
      confidenceScore: 0,
      lowConfidence: true,
      blendPolicy: row?.market_blend_policy ?? "NO_PRICE",
    };
  }

  return {
    confidenceScore: Math.round(row?.market_confidence_score ?? fallback.confidenceScore),
    lowConfidence: typeof row?.market_low_confidence === "boolean"
      ? row.market_low_confidence
      : fallback.lowConfidence,
    blendPolicy: row?.market_blend_policy ?? fallback.blendPolicy,
  };
}
