import assert from "node:assert/strict";
import {
  aggregatePrimaryVariantStats,
  buildSetId,
  choosePrimaryVariant,
} from "../lib/sets/summary-core.mjs";

export function runSetSummaryPipelineTests() {
  assert.equal(buildSetId("Scarlet & Violet: Paldea Evolved"), "scarlet-violet-paldea-evolved");

  const preferredNormal = choosePrimaryVariant([
    {
      variantRef: "holo",
      finish: "HOLO",
      observationCount30d: 30,
      latestObservedAt: "2026-03-01T10:00:00.000Z",
      latestPrice: 12,
    },
    {
      variantRef: "normal",
      finish: "NON_HOLO",
      observationCount30d: 4,
      latestObservedAt: "2026-03-01T09:00:00.000Z",
      latestPrice: 8,
    },
  ]);

  assert.equal(preferredNormal?.variantRef, "normal");

  const preferredLiquid = choosePrimaryVariant([
    {
      variantRef: "reverse",
      finish: "REVERSE_HOLO",
      observationCount30d: 8,
      latestObservedAt: "2026-03-01T08:00:00.000Z",
      latestPrice: 7,
    },
    {
      variantRef: "holo",
      finish: "HOLO",
      observationCount30d: 24,
      latestObservedAt: "2026-03-01T07:00:00.000Z",
      latestPrice: 9,
    },
  ]);

  assert.equal(preferredLiquid?.variantRef, "holo");

  const aggregate = aggregatePrimaryVariantStats([
    {
      variants: [
        {
          variantRef: "card-1-holo",
          finish: "HOLO",
          observationCount30d: 20,
          latestObservedAt: "2026-03-01T10:00:00.000Z",
          latestPrice: 10,
          price7d: 8,
          price30d: 7,
          change7dPct: 25,
          signalBreakout: 80,
          signalValue: 72,
          signalTrend: 65,
        },
        {
          variantRef: "card-1-normal",
          finish: "NON_HOLO",
          observationCount30d: 3,
          latestObservedAt: "2026-03-01T09:00:00.000Z",
          latestPrice: 6,
          price7d: 5,
          price30d: 4,
          change7dPct: 20,
          signalBreakout: 75,
          signalValue: 80,
          signalTrend: 62,
        },
      ],
    },
    {
      variants: [
        {
          variantRef: "card-2-reverse",
          finish: "REVERSE_HOLO",
          observationCount30d: 16,
          latestObservedAt: "2026-03-01T11:00:00.000Z",
          latestPrice: 14,
          price7d: 10,
          price30d: 9,
          change7dPct: 40,
          signalBreakout: 68,
          signalValue: 55,
          signalTrend: 58,
        },
      ],
    },
  ]);

  assert.equal(aggregate.primaryVariants.length, 2);
  assert.equal(aggregate.marketCap, 20);
  assert.equal(aggregate.marketCap7d, 15);
  assert.equal(aggregate.marketCap30d, 13);
  assert.equal(aggregate.breakoutCount, 1);
  assert.equal(aggregate.valueZoneCount, 1);
  assert.equal(aggregate.trendBullishCount, 1);
  assert.equal(aggregate.heatScore, 33.42);
}
