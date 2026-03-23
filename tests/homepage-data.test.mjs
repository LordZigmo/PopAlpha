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
    marketStrengthScore: null,
    marketDirection: null,
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
          snapshot_count_30d: 30,
          change_pct_24h: 14.2,
          market_confidence_score: 94,
          market_low_confidence: false,
          active_listings_7d: 7,
        },
        {
          canonical_slug: "beta-under-dollar",
          market_price: 0.94,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: 22.1,
          market_confidence_score: 93,
          market_low_confidence: false,
          active_listings_7d: 4,
        },
        {
          canonical_slug: "gamma-thin-data",
          market_price: 1.24,
          market_price_as_of: freshIso,
          snapshot_count_30d: 26,
          change_pct_24h: 18.4,
          market_confidence_score: 91,
          market_low_confidence: false,
          active_listings_7d: 4,
        },
        {
          canonical_slug: "delta-emerging",
          market_price: 1.08,
          market_price_as_of: freshIso,
          snapshot_count_30d: 27,
          change_pct_24h: 11.3,
          market_confidence_score: 92,
          market_low_confidence: false,
          active_listings_7d: 4,
        },
      ],
      negativeChangeRows: [
        {
          canonical_slug: "gamma-drop",
          market_price: 2.31,
          market_price_as_of: earlierIso,
          snapshot_count_30d: 29,
          change_pct_24h: -9.7,
          market_confidence_score: 90,
          market_low_confidence: false,
          active_listings_7d: 8,
        },
        {
          canonical_slug: "epsilon-thin-drop",
          market_price: 2.05,
          market_price_as_of: earlierIso,
          snapshot_count_30d: 25,
          change_pct_24h: -12.6,
          market_confidence_score: 92,
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
        { slug: "beta-under-dollar", canonical_name: "Beta Under Dollar", set_name: "Focus Set", year: 2026 },
        { slug: "gamma-thin-data", canonical_name: "Gamma Thin Data", set_name: "Focus Set", year: 2026 },
        { slug: "delta-emerging", canonical_name: "Delta Emerging", set_name: "Focus Set", year: 2026 },
        { slug: "gamma-drop", canonical_name: "Gamma Drop", set_name: "Reset Set", year: 2026 },
        { slug: "epsilon-thin-drop", canonical_name: "Epsilon Thin Drop", set_name: "Reset Set", year: 2026 },
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
            marketStrengthScore: 81,
            marketDirection: "bullish",
            sampleCounts7d: { justtcg: 4, scrydex: 0, total: 4 },
          }),
        ],
        [
          "beta-under-dollar",
          buildPulse({
            marketPrice: 0.94,
            marketPriceAsOf: freshIso,
            activeListings7d: 4,
            snapshotCount30d: 30,
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
          "gamma-thin-data",
          buildPulse({
            marketPrice: 1.24,
            marketPriceAsOf: freshIso,
            activeListings7d: 4,
            snapshotCount30d: 26,
            changePct24h: 18.4,
            changePct7d: 5.1,
            changePct: 5.1,
            changeWindow: "7D",
            confidenceScore: 91,
            lowConfidence: false,
            sampleCounts7d: { justtcg: 5, scrydex: 0, total: 5 },
          }),
        ],
        [
          "delta-emerging",
          buildPulse({
            marketPrice: 1.08,
            marketPriceAsOf: freshIso,
            activeListings7d: 4,
            snapshotCount30d: 27,
            changePct24h: 11.3,
            changePct7d: 4.7,
            changePct: 4.7,
            changeWindow: "7D",
            confidenceScore: 92,
            lowConfidence: false,
            marketStrengthScore: 68,
            marketDirection: "bullish",
            sampleCounts7d: { justtcg: 6, scrydex: 0, total: 6 },
          }),
        ],
        [
          "gamma-drop",
          buildPulse({
            marketPrice: 2.31,
            marketPriceAsOf: earlierIso,
            activeListings7d: 8,
            snapshotCount30d: 29,
            changePct24h: -9.7,
            changePct7d: 6.8,
            changePct: 6.8,
            changeWindow: "7D",
            confidenceScore: 90,
            lowConfidence: false,
            marketStrengthScore: 64,
            marketDirection: "bearish",
            sampleCounts7d: { justtcg: 6, scrydex: 0, total: 6 },
          }),
        ],
        [
          "epsilon-thin-drop",
          buildPulse({
            marketPrice: 2.05,
            marketPriceAsOf: earlierIso,
            activeListings7d: 8,
            snapshotCount30d: 25,
            changePct24h: -12.6,
            changePct7d: -7.9,
            changePct: -7.9,
            changeWindow: "7D",
            confidenceScore: 92,
            lowConfidence: false,
            sampleCounts7d: { justtcg: 7, scrydex: 0, total: 7 },
          }),
        ],
        [
          "trend-card",
          buildPulse({
            marketPrice: 5.4,
            marketPriceAsOf: freshIso,
            activeListings7d: 12,
            snapshotCount30d: 11,
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
      pricesRefreshedToday: 8126,
      trackedCardsWithLivePrice: 10444,
    },
  });

  assert.deepEqual(
    data.movers.map((card) => ({ slug: card.slug, change_pct: card.change_pct, change_window: card.change_window })),
    [
      { slug: "alpha-high", change_pct: 14.2, change_window: "24H" },
      { slug: "delta-emerging", change_pct: 11.3, change_window: "24H" },
    ],
  );

  assert.deepEqual(
    data.high_confidence_movers.map((card) => ({
      slug: card.slug,
      mover_tier: card.mover_tier,
      confidence_score: card.confidence_score,
      low_confidence: card.low_confidence,
      market_strength_score: card.market_strength_score,
      market_direction: card.market_direction,
    })),
    [{
      slug: "alpha-high",
      mover_tier: "hot",
      confidence_score: 94,
      low_confidence: false,
      market_strength_score: 81,
      market_direction: "bullish",
    }],
  );

  assert.deepEqual(
    data.emerging_movers.map((card) => ({ slug: card.slug, mover_tier: card.mover_tier })),
    [{ slug: "delta-emerging", mover_tier: "warming" }],
  );

  assert.deepEqual(
    data.losers.map((card) => ({ slug: card.slug, change_pct: card.change_pct, change_window: card.change_window })),
    [{ slug: "gamma-drop", change_pct: -9.7, change_window: "24H" }],
  );

  assert.deepEqual(
    data.losers.map((card) => ({ slug: card.slug, market_strength_score: card.market_strength_score, market_direction: card.market_direction })),
    [{ slug: "gamma-drop", market_strength_score: 64, market_direction: "bearish" }],
  );

  assert.deepEqual(
    data.trending.map((card) => ({ slug: card.slug, change_pct: card.change_pct, change_window: card.change_window })),
    [{ slug: "trend-card", change_pct: 6.5, change_window: "7D" }],
  );

  assert.equal(data.as_of, freshIso);
  assert.equal(data.prices_refreshed_today, 8126);
  assert.equal(data.tracked_cards_with_live_price, 10444);
}
