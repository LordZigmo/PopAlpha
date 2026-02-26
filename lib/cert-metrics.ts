export type DerivedMetrics = {
  totalPopulation: number | null;
  populationHigher: number | null;
  topGrade: boolean;
  topTierShare: number | null;
  scarcityScore: number | null;
  tierLabel: "Top tier" | "Not top tier";
  higherShare: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function getDerivedMetrics(totalPopulationValue: unknown, populationHigherValue: unknown): DerivedMetrics {
  const totalPopulation = asFiniteNumber(totalPopulationValue);
  const populationHigher = asFiniteNumber(populationHigherValue);

  const topGrade = populationHigher === 0;

  const topTierShare =
    totalPopulation !== null && totalPopulation > 0 && populationHigher !== null
      ? clamp((totalPopulation - populationHigher) / totalPopulation, 0, 1)
      : null;

  const scarcityScore =
    totalPopulation !== null && totalPopulation >= 0
      ? clamp(Math.round((100 / (1 + Math.log10(totalPopulation + 1))) * 0.7), 0, 100)
      : null;

  const higherShare =
    totalPopulation !== null && totalPopulation > 0 && populationHigher !== null
      ? clamp(populationHigher / totalPopulation, 0, 1)
      : null;

  return {
    totalPopulation,
    populationHigher,
    topGrade,
    topTierShare,
    scarcityScore,
    tierLabel: topGrade ? "Top tier" : "Not top tier",
    higherShare,
  };
}
