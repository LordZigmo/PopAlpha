import assert from "node:assert/strict";
import { resolveCanonicalMarketPulse } from "../lib/data/market.ts";

export function runMarketTruthPhase1Tests() {
  const justtcgOnly = resolveCanonicalMarketPulse({
    justtcg_price: 1.25,
    scrydex_price: null,
    pokemontcg_price: null,
    market_price: null,
    market_price_as_of: "2026-03-10T12:00:00.000Z",
    liquidity_score: 84,
    active_listings_7d: 9,
    snapshot_count_30d: 42,
    median_7d: 1.21,
    provider_trend_slope_7d: 0.09,
    provider_cov_price_30d: 0.12,
    provider_price_relative_to_30d_range: 0.31,
    provider_price_changes_count_30d: 12,
    market_confidence_score: 92,
    market_low_confidence: false,
    market_blend_policy: "SINGLE_PROVIDER",
    market_provenance: {
      sourceMix: { justtcgWeight: 1, scrydexWeight: 0 },
      sampleCounts7d: { justtcg: 7, scrydex: 0 },
    },
    change_pct_24h: 4.2,
    change_pct_7d: 6.8,
  });

  assert.equal(justtcgOnly.justtcgPrice, null);
  assert.equal(justtcgOnly.marketPrice, null);
  assert.equal(justtcgOnly.marketPriceAsOf, null);
  assert.equal(justtcgOnly.blendPolicy, "NO_PRICE");
  assert.equal(justtcgOnly.lowConfidence, true);
  assert.equal(justtcgOnly.marketStrengthScore, null);
  assert.equal(justtcgOnly.marketDirection, null);
  assert.deepEqual(justtcgOnly.sourceMix, { justtcgWeight: 0, scrydexWeight: 0 });
  assert.deepEqual(justtcgOnly.sampleCounts7d, { justtcg: 0, scrydex: 0, total: 0 });

  const blendedRow = resolveCanonicalMarketPulse({
    justtcg_price: 1.25,
    scrydex_price: 1.01,
    pokemontcg_price: 1.01,
    market_price: 1.01,
    market_price_as_of: "2026-03-10T12:00:00.000Z",
    liquidity_score: 66,
    active_listings_7d: 5,
    snapshot_count_30d: 18,
    median_7d: 1.02,
    provider_trend_slope_7d: 0.05,
    provider_cov_price_30d: 0.09,
    provider_price_relative_to_30d_range: 0.28,
    provider_price_changes_count_30d: 10,
    market_confidence_score: 77,
    market_low_confidence: false,
    market_blend_policy: "FALLBACK_STALE_OR_OUTLIER",
    market_provenance: {
      sourceMix: { justtcgWeight: 0.6, scrydexWeight: 0.4 },
      sampleCounts7d: { justtcg: 11, scrydex: 4 },
    },
    change_pct_24h: null,
    change_pct_7d: 3.1,
  });

  assert.equal(blendedRow.justtcgPrice, null);
  assert.equal(blendedRow.scrydexPrice, 1.01);
  assert.equal(blendedRow.pokemontcgPrice, null);
  assert.equal(blendedRow.marketPrice, 1.01);
  assert.equal(blendedRow.blendPolicy, "SCRYDEX_PRIMARY");
  assert.deepEqual(blendedRow.sourceMix, { justtcgWeight: 0, scrydexWeight: 1 });
  assert.deepEqual(blendedRow.sampleCounts7d, { justtcg: 0, scrydex: 4, total: 4 });
  assert.equal(blendedRow.changePct, 3.1);
  assert.equal(blendedRow.changeWindow, "7D");
  assert.ok(blendedRow.marketStrengthScore !== null);
  assert.equal(blendedRow.marketDirection, "bullish");

  const scrydexOnly = resolveCanonicalMarketPulse({
    justtcg_price: null,
    scrydex_price: 0.94,
    pokemontcg_price: 0.94,
    market_price: 0.94,
    market_price_as_of: "2026-03-10T12:00:00.000Z",
    liquidity_score: 81,
    active_listings_7d: 3,
    snapshot_count_30d: 16,
    median_7d: 0.92,
    provider_trend_slope_7d: 0.08,
    provider_cov_price_30d: 0.11,
    provider_price_relative_to_30d_range: 0.24,
    provider_price_changes_count_30d: 9,
    market_confidence_score: 88,
    market_low_confidence: false,
    market_blend_policy: "SCRYDEX_PRIMARY",
    market_provenance: {
      sourceMix: { justtcgWeight: 0, scrydexWeight: 1 },
      sampleCounts7d: { justtcg: 0, scrydex: 4 },
    },
    change_pct_24h: 5.6,
    change_pct_7d: 9.9,
  });

  assert.equal(scrydexOnly.marketPrice, 0.94);
  assert.equal(scrydexOnly.blendPolicy, "SCRYDEX_PRIMARY");
  assert.equal(scrydexOnly.confidenceScore, 88);
  assert.equal(scrydexOnly.lowConfidence, false);
  assert.equal(scrydexOnly.changePct, 5.6);
  assert.equal(scrydexOnly.changeWindow, "24H");
  assert.ok(scrydexOnly.marketStrengthScore !== null);
  assert.ok(scrydexOnly.marketStrengthScore >= 60);
  assert.equal(scrydexOnly.marketDirection, "bullish");

  const bearishScrydex = resolveCanonicalMarketPulse({
    justtcg_price: null,
    scrydex_price: 1.42,
    pokemontcg_price: 1.42,
    market_price: 1.42,
    market_price_as_of: "2026-03-10T12:00:00.000Z",
    liquidity_score: 72,
    active_listings_7d: 7,
    snapshot_count_30d: 20,
    median_7d: 1.48,
    provider_trend_slope_7d: -0.06,
    provider_cov_price_30d: 0.09,
    provider_price_relative_to_30d_range: 0.41,
    provider_price_changes_count_30d: 11,
    market_confidence_score: 83,
    market_low_confidence: false,
    market_blend_policy: "SCRYDEX_PRIMARY",
    market_provenance: {
      sourceMix: { justtcgWeight: 0, scrydexWeight: 1 },
      sampleCounts7d: { justtcg: 0, scrydex: 8 },
    },
    change_pct_24h: -6.4,
    change_pct_7d: -11.8,
  });

  assert.ok(bearishScrydex.marketStrengthScore !== null);
  assert.ok(bearishScrydex.marketStrengthScore >= 50);
  assert.equal(bearishScrydex.marketDirection, "bearish");

  const staleLiveCollapsed = resolveCanonicalMarketPulse({
    justtcg_price: null,
    scrydex_price: null,
    pokemontcg_price: 0.98,
    market_price: null,
    market_price_as_of: "2026-03-10T12:00:00.000Z",
    liquidity_score: 73,
    active_listings_7d: 6,
    snapshot_count_30d: 8,
    median_7d: 0.97,
    provider_trend_slope_7d: 0.04,
    provider_cov_price_30d: 0.07,
    provider_price_relative_to_30d_range: 0.44,
    provider_price_changes_count_30d: 8,
    market_confidence_score: 81,
    market_low_confidence: false,
    market_blend_policy: "NO_PRICE",
    market_provenance: {
      sourceMix: { justtcgWeight: 0, scrydexWeight: 1 },
      sampleCounts7d: { justtcg: 0, scrydex: 6 },
    },
    change_pct_24h: 4.1,
    change_pct_7d: 8.3,
  });

  assert.equal(staleLiveCollapsed.scrydexPrice, null);
  assert.equal(staleLiveCollapsed.pokemontcgPrice, null);
  assert.equal(staleLiveCollapsed.marketPrice, null);
  assert.equal(staleLiveCollapsed.marketPriceAsOf, null);
  assert.equal(staleLiveCollapsed.blendPolicy, "NO_PRICE");
  assert.equal(staleLiveCollapsed.marketStrengthScore, null);
  assert.equal(staleLiveCollapsed.marketDirection, null);
  assert.deepEqual(staleLiveCollapsed.sourceMix, { justtcgWeight: 0, scrydexWeight: 0 });
  assert.deepEqual(staleLiveCollapsed.sampleCounts7d, { justtcg: 0, scrydex: 0, total: 0 });
  assert.equal(staleLiveCollapsed.changePct, null);
  assert.equal(staleLiveCollapsed.changeWindow, null);
}

runMarketTruthPhase1Tests();

console.log("market truth phase1 tests passed");
