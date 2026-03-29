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
          change_pct_7d: 4.2,
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
          change_pct_7d: 3.6,
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
          change_pct_7d: 5.1,
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
          change_pct_7d: 4.7,
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
          change_pct_7d: -6.8,
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
          change_pct_7d: -7.9,
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

  const fallbackData = await getHomepageData({
    now: () => FIXED_NOW,
    logger: NOOP_LOGGER,
    dataOverrides: {
      positiveChangeRows: [
        {
          canonical_slug: "fallback-up",
          market_price: 1.62,
          market_price_as_of: freshIso,
          snapshot_count_30d: 28,
          change_pct_24h: null,
          change_pct_7d: 16.4,
          market_confidence_score: 67,
          market_low_confidence: false,
          active_listings_7d: 7,
        },
      ],
      negativeChangeRows: [
        {
          canonical_slug: "fallback-down",
          market_price: 2.44,
          market_price_as_of: freshIso,
          snapshot_count_30d: 29,
          change_pct_24h: null,
          change_pct_7d: -12.8,
          market_confidence_score: 66,
          market_low_confidence: false,
          active_listings_7d: 6,
        },
      ],
      trendingVariants: [],
      cards: [
        { slug: "fallback-up", canonical_name: "Fallback Up", set_name: "Fallback Set", year: 2026 },
        { slug: "fallback-down", canonical_name: "Fallback Down", set_name: "Fallback Set", year: 2026 },
      ],
      marketPulseMap: new Map([
        [
          "fallback-up",
          buildPulse({
            marketPrice: 1.62,
            marketPriceAsOf: freshIso,
            activeListings7d: 7,
            snapshotCount30d: 28,
            changePct24h: null,
            changePct7d: 16.4,
            changePct: 16.4,
            changeWindow: "7D",
            confidenceScore: 67,
            lowConfidence: false,
            marketStrengthScore: 72,
            marketDirection: "bullish",
          }),
        ],
        [
          "fallback-down",
          buildPulse({
            marketPrice: 2.44,
            marketPriceAsOf: freshIso,
            activeListings7d: 6,
            snapshotCount30d: 29,
            changePct24h: null,
            changePct7d: -12.8,
            changePct: -12.8,
            changeWindow: "7D",
            confidenceScore: 66,
            lowConfidence: false,
            marketStrengthScore: 69,
            marketDirection: "bearish",
          }),
        ],
      ]),
    },
  });

  assert.deepEqual(
    fallbackData.movers.map((card) => ({ slug: card.slug, change_pct: card.change_pct, change_window: card.change_window })),
    [{ slug: "fallback-up", change_pct: 16.4, change_window: "7D" }],
  );
  assert.deepEqual(
    fallbackData.losers.map((card) => ({ slug: card.slug, change_pct: card.change_pct, change_window: card.change_window })),
    [{ slug: "fallback-down", change_pct: -12.8, change_window: "7D" }],
  );

  const degradedPulseData = await getHomepageData({
    now: () => FIXED_NOW,
    logger: NOOP_LOGGER,
    dataOverrides: {
      positiveChangeRows: [
        {
          canonical_slug: "degraded-up",
          market_price: 3.1,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: 8.4,
          change_pct_7d: 10.1,
          market_confidence_score: 71,
          market_low_confidence: false,
          active_listings_7d: 9,
        },
      ],
      negativeChangeRows: [
        {
          canonical_slug: "degraded-down",
          market_price: 2.72,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: -7.6,
          change_pct_7d: -11.2,
          market_confidence_score: 69,
          market_low_confidence: false,
          active_listings_7d: 8,
        },
      ],
      trendingVariants: [],
      cards: [
        { slug: "degraded-up", canonical_name: "Degraded Up", set_name: "Fallback Set", year: 2026, primary_image_url: "https://img.example/degraded-up.png" },
        { slug: "degraded-down", canonical_name: "Degraded Down", set_name: "Fallback Set", year: 2026, primary_image_url: "https://img.example/degraded-down.png" },
      ],
      marketPulseMap: new Map(),
    },
  });

  assert.deepEqual(
    degradedPulseData.movers.map((card) => ({
      slug: card.slug,
      name: card.name,
      market_price: card.market_price,
      change_pct: card.change_pct,
      change_window: card.change_window,
      confidence_score: card.confidence_score,
      image_url: card.image_url,
    })),
    [{
      slug: "degraded-up",
      name: "Degraded Up",
      market_price: 3.1,
      change_pct: 8.4,
      change_window: "24H",
      confidence_score: 71,
      image_url: "https://img.example/degraded-up.png",
    }],
  );

  assert.deepEqual(
    degradedPulseData.losers.map((card) => ({
      slug: card.slug,
      name: card.name,
      market_price: card.market_price,
      change_pct: card.change_pct,
      change_window: card.change_window,
      confidence_score: card.confidence_score,
      image_url: card.image_url,
    })),
    [{
      slug: "degraded-down",
      name: "Degraded Down",
      market_price: 2.72,
      change_pct: -7.6,
      change_window: "24H",
      confidence_score: 69,
      image_url: "https://img.example/degraded-down.png",
    }],
  );

  const windowedSignalData = await getHomepageData({
    now: () => FIXED_NOW,
    logger: NOOP_LOGGER,
    dataOverrides: {
      positiveChangeRows: [
        {
          canonical_slug: "live-24h-anchor",
          market_price: 4.5,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: 18.1,
          change_pct_7d: null,
          market_confidence_score: 89,
          market_low_confidence: false,
          active_listings_7d: 8,
        },
        {
          canonical_slug: "live-24h-emerging",
          market_price: 2.8,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: 11.6,
          change_pct_7d: null,
          market_confidence_score: 84,
          market_low_confidence: false,
          active_listings_7d: 4,
        },
        {
          canonical_slug: "live-7d-alpha",
          market_price: 6.3,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: null,
          change_pct_7d: 25.2,
          market_confidence_score: 91,
          market_low_confidence: false,
          active_listings_7d: 9,
        },
        {
          canonical_slug: "live-7d-beta",
          market_price: 5.1,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: null,
          change_pct_7d: 22.4,
          market_confidence_score: 88,
          market_low_confidence: false,
          active_listings_7d: 7,
        },
        {
          canonical_slug: "live-7d-gamma",
          market_price: 4.6,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: null,
          change_pct_7d: 19.8,
          market_confidence_score: 82,
          market_low_confidence: false,
          active_listings_7d: 4,
        },
        {
          canonical_slug: "live-7d-delta",
          market_price: 4.2,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: null,
          change_pct_7d: 16.7,
          market_confidence_score: 86,
          market_low_confidence: false,
          active_listings_7d: 8,
        },
        {
          canonical_slug: "live-7d-epsilon",
          market_price: 3.9,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: null,
          change_pct_7d: 14.4,
          market_confidence_score: 79,
          market_low_confidence: false,
          active_listings_7d: 4,
        },
      ],
      negativeChangeRows: [
        {
          canonical_slug: "drop-24h-anchor",
          market_price: 3.8,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: -12.2,
          change_pct_7d: null,
          market_confidence_score: 85,
          market_low_confidence: false,
          active_listings_7d: 8,
        },
        {
          canonical_slug: "drop-7d-alpha",
          market_price: 4.8,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: null,
          change_pct_7d: -17.3,
          market_confidence_score: 87,
          market_low_confidence: false,
          active_listings_7d: 7,
        },
        {
          canonical_slug: "drop-7d-beta",
          market_price: 4.1,
          market_price_as_of: freshIso,
          snapshot_count_30d: 30,
          change_pct_24h: null,
          change_pct_7d: -13.5,
          market_confidence_score: 83,
          market_low_confidence: false,
          active_listings_7d: 6,
        },
      ],
      trendingVariants: [
        {
          canonical_slug: "trend-7d-alpha",
          provider_trend_slope_7d: 12.4,
          provider_price_changes_count_30d: 14,
          updated_at: freshIso,
        },
        {
          canonical_slug: "trend-7d-beta",
          provider_trend_slope_7d: 9.8,
          provider_price_changes_count_30d: 11,
          updated_at: freshIso,
        },
      ],
      cards: [
        { slug: "live-24h-anchor", canonical_name: "Live 24H Anchor", set_name: "Focus Set", year: 2026 },
        { slug: "live-24h-emerging", canonical_name: "Live 24H Emerging", set_name: "Focus Set", year: 2026 },
        { slug: "live-7d-alpha", canonical_name: "Live 7D Alpha", set_name: "Momentum Set", year: 2026 },
        { slug: "live-7d-beta", canonical_name: "Live 7D Beta", set_name: "Momentum Set", year: 2026 },
        { slug: "live-7d-gamma", canonical_name: "Live 7D Gamma", set_name: "Momentum Set", year: 2026 },
        { slug: "live-7d-delta", canonical_name: "Live 7D Delta", set_name: "Momentum Set", year: 2026 },
        { slug: "live-7d-epsilon", canonical_name: "Live 7D Epsilon", set_name: "Momentum Set", year: 2026 },
        { slug: "drop-24h-anchor", canonical_name: "Drop 24H Anchor", set_name: "Reset Set", year: 2026 },
        { slug: "drop-7d-alpha", canonical_name: "Drop 7D Alpha", set_name: "Reset Set", year: 2026 },
        { slug: "drop-7d-beta", canonical_name: "Drop 7D Beta", set_name: "Reset Set", year: 2026 },
        { slug: "trend-7d-alpha", canonical_name: "Trend 7D Alpha", set_name: "Trend Set", year: 2026 },
        { slug: "trend-7d-beta", canonical_name: "Trend 7D Beta", set_name: "Trend Set", year: 2026 },
      ],
      marketPulseMap: new Map([
        [
          "live-24h-anchor",
          buildPulse({
            marketPrice: 4.5,
            marketPriceAsOf: freshIso,
            activeListings7d: 8,
            snapshotCount30d: 30,
            changePct24h: 18.1,
            changePct7d: null,
            changePct: 18.1,
            changeWindow: "24H",
            confidenceScore: 89,
            lowConfidence: false,
          }),
        ],
        [
          "live-24h-emerging",
          buildPulse({
            marketPrice: 2.8,
            marketPriceAsOf: freshIso,
            activeListings7d: 4,
            snapshotCount30d: 30,
            changePct24h: 11.6,
            changePct7d: null,
            changePct: 11.6,
            changeWindow: "24H",
            confidenceScore: 84,
            lowConfidence: false,
          }),
        ],
        [
          "live-7d-alpha",
          buildPulse({
            marketPrice: 6.3,
            marketPriceAsOf: freshIso,
            activeListings7d: 9,
            snapshotCount30d: 30,
            changePct24h: null,
            changePct7d: 25.2,
            changePct: 25.2,
            changeWindow: "7D",
            confidenceScore: 91,
            lowConfidence: false,
          }),
        ],
        [
          "live-7d-beta",
          buildPulse({
            marketPrice: 5.1,
            marketPriceAsOf: freshIso,
            activeListings7d: 7,
            snapshotCount30d: 30,
            changePct24h: null,
            changePct7d: 22.4,
            changePct: 22.4,
            changeWindow: "7D",
            confidenceScore: 88,
            lowConfidence: false,
          }),
        ],
        [
          "live-7d-gamma",
          buildPulse({
            marketPrice: 4.6,
            marketPriceAsOf: freshIso,
            activeListings7d: 4,
            snapshotCount30d: 30,
            changePct24h: null,
            changePct7d: 19.8,
            changePct: 19.8,
            changeWindow: "7D",
            confidenceScore: 82,
            lowConfidence: false,
          }),
        ],
        [
          "live-7d-delta",
          buildPulse({
            marketPrice: 4.2,
            marketPriceAsOf: freshIso,
            activeListings7d: 8,
            snapshotCount30d: 30,
            changePct24h: null,
            changePct7d: 16.7,
            changePct: 16.7,
            changeWindow: "7D",
            confidenceScore: 86,
            lowConfidence: false,
          }),
        ],
        [
          "live-7d-epsilon",
          buildPulse({
            marketPrice: 3.9,
            marketPriceAsOf: freshIso,
            activeListings7d: 4,
            snapshotCount30d: 30,
            changePct24h: null,
            changePct7d: 14.4,
            changePct: 14.4,
            changeWindow: "7D",
            confidenceScore: 79,
            lowConfidence: false,
          }),
        ],
        [
          "drop-24h-anchor",
          buildPulse({
            marketPrice: 3.8,
            marketPriceAsOf: freshIso,
            activeListings7d: 8,
            snapshotCount30d: 30,
            changePct24h: -12.2,
            changePct7d: null,
            changePct: -12.2,
            changeWindow: "24H",
            confidenceScore: 85,
            lowConfidence: false,
          }),
        ],
        [
          "drop-7d-alpha",
          buildPulse({
            marketPrice: 4.8,
            marketPriceAsOf: freshIso,
            activeListings7d: 7,
            snapshotCount30d: 30,
            changePct24h: null,
            changePct7d: -17.3,
            changePct: -17.3,
            changeWindow: "7D",
            confidenceScore: 87,
            lowConfidence: false,
          }),
        ],
        [
          "drop-7d-beta",
          buildPulse({
            marketPrice: 4.1,
            marketPriceAsOf: freshIso,
            activeListings7d: 6,
            snapshotCount30d: 30,
            changePct24h: null,
            changePct7d: -13.5,
            changePct: -13.5,
            changeWindow: "7D",
            confidenceScore: 83,
            lowConfidence: false,
          }),
        ],
        [
          "trend-7d-alpha",
          buildPulse({
            marketPrice: 7.2,
            marketPriceAsOf: freshIso,
            activeListings7d: 10,
            snapshotCount30d: 18,
            changePct24h: null,
            changePct7d: 12.4,
            changePct: 12.4,
            changeWindow: "7D",
            confidenceScore: 90,
            lowConfidence: false,
          }),
        ],
        [
          "trend-7d-beta",
          buildPulse({
            marketPrice: 6.7,
            marketPriceAsOf: freshIso,
            activeListings7d: 8,
            snapshotCount30d: 16,
            changePct24h: null,
            changePct7d: 9.8,
            changePct: 9.8,
            changeWindow: "7D",
            confidenceScore: 88,
            lowConfidence: false,
          }),
        ],
      ]),
    },
  });

  assert.deepEqual(
    windowedSignalData.movers.map((card) => card.slug),
    [
      "live-7d-alpha",
      "live-7d-beta",
      "live-7d-gamma",
      "live-24h-anchor",
      "live-7d-delta",
    ],
  );

  assert.deepEqual(
    windowedSignalData.signal_board.top_movers["24H"].map((card) => card.slug),
    ["live-24h-anchor", "live-24h-emerging"],
  );

  assert.deepEqual(
    windowedSignalData.signal_board.top_movers["7D"].map((card) => card.slug),
    [
      "live-7d-alpha",
      "live-7d-beta",
      "live-7d-delta",
      "live-7d-gamma",
      "live-7d-epsilon",
    ],
  );

  assert.deepEqual(
    windowedSignalData.signal_board.biggest_drops["24H"].map((card) => card.slug),
    ["drop-24h-anchor"],
  );

  assert.deepEqual(
    windowedSignalData.signal_board.biggest_drops["7D"].map((card) => card.slug),
    ["drop-7d-alpha", "drop-7d-beta"],
  );

  assert.deepEqual(
    windowedSignalData.signal_board.momentum["24H"].map((card) => card.slug),
    ["live-24h-emerging", "live-24h-anchor"],
  );

  assert.deepEqual(
    windowedSignalData.signal_board.momentum["7D"].map((card) => card.slug),
    [
      "trend-7d-alpha",
      "trend-7d-beta",
      "live-7d-alpha",
      "live-7d-beta",
      "live-7d-gamma",
    ],
  );
}
