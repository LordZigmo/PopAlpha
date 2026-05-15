export type PriceObservationTone = "positive" | "warning" | "neutral";

export function priceObservationDensityLabel(
  observations7d: number | null | undefined,
): { label: string; tone: PriceObservationTone } {
  if (observations7d === null || observations7d === undefined || !Number.isFinite(observations7d)) {
    return { label: "Market Forming", tone: "neutral" };
  }
  if (observations7d <= 4) return { label: "Light Tracking", tone: "warning" };
  if (observations7d < 30) return { label: "Steady Tracking", tone: "neutral" };
  return { label: "Deep Tracking", tone: "positive" };
}

export function priceObservationActivityLabel(
  observations7d: number | null | undefined,
): { label: string; tone: PriceObservationTone } {
  if (observations7d === null || observations7d === undefined || !Number.isFinite(observations7d)) {
    return { label: "Forming", tone: "neutral" };
  }
  if (observations7d <= 4) return { label: "Low Sample", tone: "warning" };
  if (observations7d <= 10) return { label: "Building", tone: "neutral" };
  return { label: "Active Tracking", tone: "positive" };
}
