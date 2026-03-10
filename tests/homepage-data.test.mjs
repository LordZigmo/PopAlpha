import assert from "node:assert/strict";
import { getHomepageData } from "../lib/data/homepage.ts";

const FIXED_NOW = Date.parse("2026-03-10T12:00:00.000Z");
const NOOP_LOGGER = {
  error() {},
  info() {},
};

function buildPulse(overrides = {}) {
  return {
    justtcgPrice: null,
    scrydexPrice: null,
    pokemontcgPrice: null,
    marketPrice: null,
    marketPriceAsOf: null,
    activeListings7d: null,
    snapshotCount30d: null,
    changePct24h: null,
    changePct7d: null,
    changePct: null,
    changeWindow: null,
    parityStatus: "UNKNOWN",
    confidenceScore: 90,
    lowConfidence: false,
    sourceMix: { justtcgWeight: 1, scrydexWeight: 0 },
    sampleCounts7d: { justtcg: 0, scrydex: 0, total: 0 },
    ...overrides,
  };
}

export async function runHomepageDataTests() {
  const freshIso = "2026-03-10T11:30:00.000Z";
  const earlierIso = "2026-03-10T10:15:00.000Z";

  const data = await getHomepageData({
    now: () => FIXED_NOW,
    logger: NOOP_LOGGER,
    dataOverrides: {
      positiveChangeRows: [
        {
          canonical_slug: "alpha-high",
          market_price: 1.12,
          market_price_as_of: freshIso,
          change_pct_24h: 14.2,
          market_confidence_score: 94,
          market_low_confidence: false,
          active_listings_7d: 7,
        },
        {
          canonical_slug: "beta-emerging",
          market_price: 0.94,
          market_price_as_of: freshIso,
          change_pct_24h: 22.1,
          market_confidence_score: 93,
          market_low_confidence: false,
          active_listings_7d: 4,
        },
      ],
      negativeChangeRows: [
        {
          canonical_slug: "gamma-drop",
          market_price: 2.31,
          market_price_as_of: earlierIso,
          change_pct_24h: -9.7,
          market_confidence_score: 90,
          market_low_confidence: false,
          active_listings_7d: 8,
        },
      ],
      trendingVariants: [
        {
          canonical_slug: "trend-card",
          provider_trend_slope_7d: 6.5,
          provider_price_changes_count_30d: 12,
          updated_at: freshIso,
        },
      ],
      cards: [
        { slug: "alpha-high", canonical_name: "Alpha High", set_name: "Focus Set", year: 2026 },
        { slug: "beta-emerging", canonical_name: "Beta Emerging", set_name: "Focus Set", year: 2026 },
        { slug: "gamma-drop", canonical_name: "Gamma Drop", set_name: "Reset Set", year: 2026 },
        { slug: "trend-card", canonical_name: "Trend Card", set_name: "Trend Set", year: 2025 },
      ],
      marketPulseMap: new Map([
        [
          "alpha-high",
          buildPulse({
            marketPrice: 1.12,
            marketPriceAsOf: freshIso,
            activeListings7d: 7,
            changePct24h: 14.2,
            changePct7d: 4.2,
            changePct: 4.2,
            changeWindow: "7D",
            confidenceScore: 94,
            lowConfidence: false,
            sampleCounts7d: { justtcg: 4, scrydex: 0, total: 4 },
          }),
        ],
        [
          "beta-emerging",
          buildPulse({
            marketPrice: 0.94,
            marketPriceAsOf: freshIso,
            activeListings7d: 4,
            changePct24h: 22.1,
            changePct7d: 3.6,
            changePct: 3.6,
            changeWindow: "7D",
            confidenceScore: 93,
            lowConfidence: false,
            sampleCounts7d: { justtcg: 3, scrydex: 0, total: 3 },
          }),
        ],
        [
          "gamma-drop",
          buildPulse({
            marketPrice: 2.31,
            marketPriceAsOf: earlierIso,
            activeListings7d: 8,
            changePct24h: -9.7,
            changePct7d: 6.8,
            changePct: 6.8,
            changeWindow: "7D",
            confidenceScore: 90,
            lowConfidence: false,
            sampleCounts7d: { justtcg: 6, scrydex: 0, total: 6 },
          }),
        ],
        [
          "trend-card",
          buildPulse({
            marketPrice: 5.4,
            marketPriceAsOf: freshIso,
            activeListings7d: 12,
            changePct24h: 18.2,
            changePct7d: 31.7,
            changePct: 18.2,
            changeWindow: "24H",
            confidenceScore: 91,
            lowConfidence: false,
            sampleCounts7d: { justtcg: 9, scrydex: 2, total: 11 },
          }),
        ],
      ]),
      images: [
        { canonical_slug: "alpha-high", image_url: "https://img.example/alpha-high.png" },
      ],
      sparklineRows: [
        { canonical_slug: "alpha-high", price: 1.01 },
        { canonical_slug: "alpha-high", price: 1.12 },
      ],
    },
  });

  assert.deepEqual(
    data.movers.map((card) => ({ slug: card.slug, change_pct: card.change_pct, change_window: card.change_window })),
    [
      { slug: "beta-emerging", change_pct: 22.1, change_window: "24H" },
      { slug: "alpha-high", change_pct: 14.2, change_window: "24H" },
    ],
  );

  assert.deepEqual(
    data.high_confidence_movers.map((card) => ({ slug: card.slug, mover_tier: card.mover_tier })),
    [{ slug: "alpha-high", mover_tier: "hot" }],
  );

  assert.deepEqual(
    data.emerging_movers.map((card) => ({ slug: card.slug, mover_tier: card.mover_tier })),
    [{ slug: "beta-emerging", mover_tier: "warming" }],
  );

  assert.deepEqual(
    data.losers.map((card) => ({ slug: card.slug, change_pct: card.change_pct, change_window: card.change_window })),
    [{ slug: "gamma-drop", change_pct: -9.7, change_window: "24H" }],
  );

  assert.deepEqual(
    data.trending.map((card) => ({ slug: card.slug, change_pct: card.change_pct, change_window: card.change_window })),
    [{ slug: "trend-card", change_pct: 6.5, change_window: "7D" }],
  );

  assert.equal(data.as_of, freshIso);
}
