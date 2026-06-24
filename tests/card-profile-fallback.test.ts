import assert from "node:assert/strict";

import {
  buildFallbackProfile,
  CARD_PROFILE_MODEL_LABEL,
  identifyFallbackTier,
  type CardProfileInput,
} from "../lib/ai/card-profile-fallback";

// ── Test fixture ────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CardProfileInput> = {}): CardProfileInput {
  return {
    canonicalSlug: "pikachu-base-set-58",
    canonicalName: "Pikachu",
    setName: "Base Set",
    cardNumber: "58",
    marketPrice: 0.30,
    median7d: 0.30,
    median30d: 0.30,
    changePct7d: 0,
    low30d: 0.25,
    high30d: 0.35,
    priceObservations7d: 12,
    volatility30d: 5,
    liquidityScore: 40,
    conditionPrices: null,
    rarity: "Common",
    year: 2024,
    isDigital: false,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

export async function runCardProfileFallbackTests() {
  // ── Tier identification ───────────────────────────────────────────────────

  assert.equal(
    identifyFallbackTier(makeInput({ marketPrice: 0.30, rarity: "Common", year: 2024 })),
    "bulk",
    "tier: $0.30 Common from 2024 → bulk",
  );

  assert.equal(
    identifyFallbackTier(makeInput({ marketPrice: 1.50, rarity: "Rare", year: 2023 })),
    "set_completion",
    "tier: $1.50 Rare from 2023 → set_completion",
  );

  assert.equal(
    identifyFallbackTier(makeInput({ marketPrice: 4, rarity: "Common", year: 2003 })),
    "vintage_cheap",
    "tier: $4 from 2003 → vintage_cheap (age beats bulk)",
  );

  assert.equal(
    identifyFallbackTier(makeInput({ marketPrice: 2, rarity: null, isDigital: true })),
    "digital",
    "tier: digital flag wins regardless of price/rarity",
  );

  assert.equal(
    identifyFallbackTier(makeInput({ marketPrice: 120, rarity: "Ultra Rare" })),
    "mid_premium",
    "tier: $120 Ultra Rare → mid_premium",
  );

  assert.equal(
    identifyFallbackTier(makeInput({ marketPrice: 1, rarity: "Hyper Rare" })),
    "mid_premium",
    "tier: $1 Hyper Rare → mid_premium (premium rarity blocks set_completion)",
  );

  assert.equal(
    identifyFallbackTier(makeInput({ marketPrice: 0.50, rarity: null, year: 2024 })),
    "bulk",
    "tier: null rarity at sub-$1 → bulk (default-bulk)",
  );

  assert.equal(
    identifyFallbackTier(makeInput({ marketPrice: null, rarity: null, year: null })),
    "mid_premium",
    "tier: all-nulls → mid_premium (no signal to dispatch on)",
  );

  // ── Low-dollar floor (≤ $2): deterministic honest note, no tier prose ──────

  {
    // A $0.30 bulk common is below the floor → low-dollar note, not a tier
    // narrative (the `bulk` tier is now shadowed by the floor entirely).
    const result = buildFallbackProfile(
      makeInput({ canonicalName: "Patrat", marketPrice: 0.30, rarity: "Common", setName: "Sword & Shield" }),
    );
    assert.equal(result.source, "low_dollar");
    assert.match(result.summaryShort, /Low-dollar card/);
    assert.match(result.summaryShort, /too thin/);
    assert.equal(result.signalLabel, "STEADY");
    assert.equal(result.verdict, "INSUFFICIENT_DATA");
    assert.equal(result.chip, "💵 Low-dollar");
    // Never fabricate a move/trend on a sub-$2 card.
    assert.doesNotMatch(result.summaryLong, /up \+|down -|decrease|increase|% over/);
  }

  // ── Set-completion narrative ──────────────────────────────────────────────

  {
    // $2.50 Rare — ABOVE the $2 floor, still set_completion (< $3), so it keeps
    // the "finishing the set" narrative (the tier is reachable in $2–$3).
    const result = buildFallbackProfile(
      makeInput({ canonicalName: "Roselia", marketPrice: 2.50, rarity: "Rare", setName: "Stellar Crown", year: 2024 }),
    );
    assert.equal(result.source, "fallback");
    assert.match(result.summaryLong, /finishing the Stellar Crown set/);
    assert.match(result.summaryLong, /\$2\.50/);
  }

  // ── Vintage cheap narrative ───────────────────────────────────────────────

  {
    const result = buildFallbackProfile(
      makeInput({ canonicalName: "Latios", marketPrice: 4, rarity: "Rare Holo", setName: "Skyridge", year: 2003 }),
    );
    assert.equal(result.source, "fallback");
    assert.match(result.summaryLong, /2003 card from Skyridge/);
    assert.match(result.summaryLong, /piece of older TCG history/);
  }

  // ── Digital narrative ─────────────────────────────────────────────────────

  {
    // Digital narrative at $5 — above the floor, so it exercises the digital
    // tier rather than the low-dollar note.
    const result = buildFallbackProfile(
      makeInput({ marketPrice: 5, isDigital: true, setName: "Genetic Apex", year: 2024, rarity: null }),
    );
    assert.equal(result.source, "fallback");
    assert.match(result.summaryLong, /Digital card from Genetic Apex/);
    assert.match(result.summaryLong, /no physical print/);
  }

  // ── Mid/premium narrative (existing 3-step pattern unchanged) ─────────────

  {
    const result = buildFallbackProfile(
      makeInput({
        canonicalName: "Charizard",
        marketPrice: 120,
        rarity: "Ultra Rare",
        setName: "Obsidian Flames",
        year: 2024,
        changePct7d: 0,
      }),
    );
    assert.equal(result.source, "fallback");
    // Mid/premium STEADY card: original pattern starts with "<name> is holding steady".
    assert.match(result.summaryLong, /Charizard is holding steady around \$120/);
    assert.match(result.summaryLong, /no clear move in either direction/);
  }

  {
    const result = buildFallbackProfile(
      makeInput({
        canonicalName: "Umbreon ex",
        marketPrice: 1418.7,
        recentMarketSignalUsd: 1750.5,
        recentMarketSignalDirection: "HIGHER",
        recentMarketSignalDeltaPct: 23.4,
        rarity: "Special Illustration Rare",
        setName: "Prismatic Evolutions",
        year: 2025,
      }),
    );
    assert.match(result.summaryLong, /Market Price is around \$1,419/);
    assert.match(result.summaryLong, /recent market signals are higher near \$1,751/);
  }

  // ── Low-dollar move suppression (the Krookodile/Xerneas case) ─────────────

  {
    // A $0.80 card "up +25%" is penny-rounding noise, not a breakout. The floor
    // wins over the mover narrative — no "+25% / strong move" prose, no BREAKOUT
    // badge. This is exactly the screenshot the floor exists to kill.
    const result = buildFallbackProfile(
      makeInput({
        canonicalName: "Patrat",
        marketPrice: 0.80,
        rarity: "Common",
        setName: "Sword & Shield",
        changePct7d: 25,
      }),
    );
    assert.equal(result.source, "low_dollar");
    assert.match(result.summaryShort, /Low-dollar card/);
    assert.doesNotMatch(result.summaryLong, /\+25%|strong move|BREAKOUT|bulk-tier/);
    assert.equal(result.signalLabel, "STEADY");
    assert.equal(result.verdict, "INSUFFICIENT_DATA");
  }

  // ── Missing rarity / missing year (graceful fall-through) ─────────────────

  {
    const result = buildFallbackProfile(
      makeInput({
        canonicalName: "Mystery Card",
        marketPrice: 5,
        rarity: null,
        year: null,
        setName: "Unknown Set",
        changePct7d: 0,
      }),
    );
    assert.equal(result.source, "fallback");
    // $5 with null rarity, null year → mid_premium → existing 3-step
    assert.match(result.summaryLong, /Mystery Card is holding steady around \$5/);
    // shouldn't crash on null rarity / year
    assert.equal(typeof result.summaryShort, "string");
    assert.ok(result.summaryShort.length > 0);
  }

  // ── modelLabel / source / metricsHash invariants ──────────────────────────

  {
    const result = buildFallbackProfile(makeInput());
    assert.equal(result.source, "low_dollar");
    assert.equal(result.modelLabel, CARD_PROFILE_MODEL_LABEL);
    assert.equal(result.inputTokens, null);
    assert.equal(result.outputTokens, null);
    assert.equal(typeof result.metricsHash, "string");
    assert.equal(result.metricsHash.length, 16);
  }

  console.log("card-profile fallback tests passed");
}
