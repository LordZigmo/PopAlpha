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
      ? (() => {
          const pop = totalPopulation;

          // Population-first buckets (psychologically matches collector intuition):
          // <100 => very scarce, 100-1000 => scarce/moderate, >5000 => common.
          let baseScore: number;
          if (pop < 100) {
            baseScore = 100 - Math.log10(pop + 1) * 9; // ~82 to 100
          } else if (pop < 1000) {
            baseScore = 80 - (Math.log10(pop) - 2) * 30; // 50 to 80
          } else if (pop < 5000) {
            baseScore = 50 - ((pop - 1000) / 4000) * 12; // 38 to 50
          } else {
            baseScore = 38 - Math.log10(pop / 5000 + 1) * 15; // <40
          }

          // Small tier-based nudge to align score with tier status/share.
          let adjusted = baseScore;
          if (topGrade) {
            adjusted += 7;
          } else if (topTierShare !== null) {
            adjusted += (topTierShare - 0.5) * 16;
          }

          return clamp(Math.round(adjusted), 0, 100);
        })()
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
