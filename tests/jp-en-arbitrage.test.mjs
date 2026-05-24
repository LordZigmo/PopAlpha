import assert from "node:assert/strict";
import { buildJpEnArbitrageOpportunity } from "../lib/arbitrage/jp-en-arbitrage.ts";

const NOW_MS = Date.parse("2026-05-24T20:00:00.000Z");

function pair(overrides = {}) {
  return {
    en_slug: "base-4-charizard",
    jp_slug: "expansion-pack-6-charizard-jp",
    confidence: 0.97,
    source: "image_embedding_v1",
    ...overrides,
  };
}

function card(overrides = {}) {
  return {
    slug: "base-4-charizard",
    canonical_name: "Charizard",
    set_name: "Base Set",
    year: 1999,
    card_number: "4",
    language: "EN",
    primary_image_url: null,
    mirrored_primary_image_url: null,
    mirrored_primary_thumb_url: null,
    ...overrides,
  };
}

function enMetric(overrides = {}) {
  return {
    canonical_slug: "base-4-charizard",
    market_price: 100,
    market_price_as_of: "2026-05-24T18:00:00.000Z",
    market_confidence_score: 88,
    market_low_confidence: false,
    active_listings_7d: 12,
    snapshot_count_30d: 42,
    ...overrides,
  };
}

function jpCoverage(overrides = {}) {
  return {
    canonicalSlug: "expansion-pack-6-charizard-jp",
    displayPriceSource: "snkrdunk",
    displayPriceUsd: 122,
    displayPriceJpy: 17942,
    displayPriceAsOf: "2026-05-24T19:00:00.000Z",
    displayPriceSampleCount: 11,
    marketPrice: null,
    marketPriceAsOf: null,
    marketConfidenceScore: null,
    marketLowConfidence: null,
    activeListings7d: null,
    snapshotCount30d: null,
    changePct24h: null,
    changePct7d: null,
    yahooJpPriceUsd: null,
    yahooJpPriceJpy: null,
    yahooJpSampleCount: null,
    yahooJpObservedAt: null,
    snkrdunkPriceUsd: 122,
    snkrdunkPriceJpy: 17942,
    snkrdunkSampleCount: 11,
    snkrdunkObservedAt: "2026-05-24T19:00:00.000Z",
    ...overrides,
  };
}

export function runJpEnArbitrageTests() {
  const jpPremium = buildJpEnArbitrageOpportunity({
    pair: pair(),
    enCard: card(),
    jpCard: card({
      slug: "expansion-pack-6-charizard-jp",
      canonical_name: "Charizard",
      set_name: "Expansion Pack",
      language: "JP",
    }),
    enMetric: enMetric(),
    jpCoverage: jpCoverage(),
    estimatedFrictionPct: 12,
    nowMs: NOW_MS,
  });

  assert.ok(jpPremium);
  assert.equal(jpPremium.direction, "JP_PREMIUM");
  assert.equal(jpPremium.action, "BUY_EN_SELL_JP");
  assert.equal(jpPremium.spread.jpPremiumPct, 22);
  assert.equal(jpPremium.spread.netEdgePct, 10);
  assert.equal(jpPremium.jp.source, "snkrdunk");
  assert.equal(jpPremium.jp.priceJpy, 17942);
  assert.match(jpPremium.headline, /JP buyers are paying a 22\.0% premium/);

  const enPremium = buildJpEnArbitrageOpportunity({
    pair: pair(),
    enCard: card(),
    jpCard: card({ slug: "expansion-pack-6-charizard-jp", language: "JP" }),
    enMetric: enMetric({ market_price: 130 }),
    jpCoverage: jpCoverage({ displayPriceUsd: 100, displayPriceJpy: 14705 }),
    estimatedFrictionPct: 12,
    nowMs: NOW_MS,
  });

  assert.ok(enPremium);
  assert.equal(enPremium.direction, "EN_PREMIUM");
  assert.equal(enPremium.action, "BUY_JP_SELL_EN");
  assert.equal(enPremium.spread.absolutePremiumPct, 23.1);
  assert.equal(enPremium.spread.netEdgePct, 11.1);

  const belowFriction = buildJpEnArbitrageOpportunity({
    pair: pair(),
    enCard: card(),
    jpCard: card({ slug: "expansion-pack-6-charizard-jp", language: "JP" }),
    enMetric: enMetric({ market_price: 100 }),
    jpCoverage: jpCoverage({ displayPriceUsd: 106 }),
    estimatedFrictionPct: 12,
    nowMs: NOW_MS,
  });

  assert.ok(belowFriction);
  assert.equal(belowFriction.direction, "JP_PREMIUM");
  assert.equal(belowFriction.action, "WATCH");
  assert.equal(belowFriction.spread.netEdgePct, -6);

  const missingPrice = buildJpEnArbitrageOpportunity({
    pair: pair(),
    enCard: card(),
    jpCard: card({ slug: "expansion-pack-6-charizard-jp", language: "JP" }),
    enMetric: enMetric({ market_price: null }),
    jpCoverage: jpCoverage(),
    nowMs: NOW_MS,
  });

  assert.equal(missingPrice, null);
}

runJpEnArbitrageTests();

console.log("jp/en arbitrage tests passed");
