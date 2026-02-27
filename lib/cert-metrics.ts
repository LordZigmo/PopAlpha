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

function scarcityFromPopulation(totalPopulation: number): number {
  if (totalPopulation <= 0) return 100;

  if (totalPopulation < 100) {
    // 83-95
    return 95 - (totalPopulation / 100) * 12;
  }

  if (totalPopulation < 1000) {
    // 80-50
    const t = (totalPopulation - 100) / 900;
    return 80 - t * 30;
  }

  if (totalPopulation < 5000) {
    // 60-30
    const t = (totalPopulation - 1000) / 4000;
    return 60 - t * 30;
  }

  // <40 and decays toward single digits as population grows
  const logDrop = Math.log10(totalPopulation / 5000);
  return 38 - logDrop * 14;
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
          let score = scarcityFromPopulation(pop);

          if (topTierShare !== null) {
            // Share nudge keeps score coherent with higher/none-higher context.
            score += (topTierShare - 0.5) * 10;
          }

          if (topGrade && pop < 1000) {
            // Prevent obvious top-tier + low-pop cases from reading too low.
            score = Math.max(score, 82);
          }

          return clamp(Math.round(score), 0, 100);
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
