import assert from "node:assert/strict";

import { PROFILE_VERSION, STYLE_DIMENSIONS } from "@/lib/personalization/constants.ts";
import {
  COLLECTOR_BEST_MOVES,
  COLLECTOR_FIT_LABELS,
} from "@/lib/personalization/types.ts";
import { buildCollectorInsightTemplate } from "@/lib/personalization/explanation/collector-insight-template.ts";
import { getCardStyleFeatures } from "@/lib/personalization/features/card-features.ts";

function zeros() {
  const s = {};
  for (const dim of STYLE_DIMENSIONS) s[dim] = 0;
  return s;
}

function profile(overrides = {}) {
  return {
    actor_key: "guest:test",
    dominant_style_label: "art-first collector",
    supporting_traits: ["iconic-character", "modern-focused"],
    summary: "You tend to favor art-forward cards.",
    confidence: 0.7,
    evidence: [],
    scores: { ...zeros(), art_affinity: 0.8, iconic_character_bias: 0.4, modern_affinity: 0.4 },
    event_count: 30,
    version: PROFILE_VERSION,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const ALT_ART_CARD = {
  canonical_slug: "umbreon-vmax-alt-art-215",
  canonical_name: "Umbreon VMAX (Alt Art)",
  set_name: "Evolving Skies",
};

const COMMON_CARD = {
  canonical_slug: "rattata-base-set-61",
  canonical_name: "Rattata (Base Set)",
  set_name: "Base Set",
};

function altArtFeatures() {
  return getCardStyleFeatures(
    {
      canonical_slug: ALT_ART_CARD.canonical_slug,
      set_name: ALT_ART_CARD.set_name,
      release_year: 2021,
      rarity: "Alt Art Secret Rare",
      card_number: "215",
      finish: "HOLO",
      is_graded: false,
    },
    { active_listings_7d: 40, liquidity_score: 90, volatility_30d: 30 },
  );
}

function commonFeatures() {
  return getCardStyleFeatures(
    {
      canonical_slug: COMMON_CARD.canonical_slug,
      set_name: COMMON_CARD.set_name,
      release_year: 1999,
      rarity: "Common",
      card_number: "61",
      finish: "NONHOLO",
      is_graded: false,
    },
    { active_listings_7d: 2, liquidity_score: 10, volatility_30d: 5 },
  );
}

function richSignals(overrides = {}) {
  return {
    collectorType: "art-first collector",
    supportingTraits: ["iconic-character", "modern-focused"],
    profileConfidence: 0.7,
    eventCount: 30,
    savedCardNames: ["Charizard ex (SIR)", "Giratina V (Alt Art)"],
    watchlistCardNames: ["Mew VMAX (Alt Art)"],
    scannedCardNames: ["Rayquaza VMAX (Alt Art)"],
    repeatedlyViewedCardNames: ["Umbreon VMAX (Alt Art)"],
    favoriteSets: ["Evolving Skies", "Crown Zenith"],
    gradedVsRawInterest: "raw",
    languagePreference: "en",
    dataConfidence: "high",
    ...overrides,
  };
}

function thinSignals(overrides = {}) {
  return {
    collectorType: "emerging collector",
    supportingTraits: [],
    profileConfidence: 0,
    eventCount: 1,
    savedCardNames: [],
    watchlistCardNames: [],
    scannedCardNames: [],
    repeatedlyViewedCardNames: [],
    favoriteSets: [],
    gradedVsRawInterest: "unknown",
    languagePreference: "unknown",
    dataConfidence: "none",
    ...overrides,
  };
}

function assertContract(out) {
  // Every field present and well-typed.
  assert.ok(COLLECTOR_FIT_LABELS.includes(out.fitLabel), `fitLabel must be one of the fixed labels: ${out.fitLabel}`);
  assert.ok(COLLECTOR_BEST_MOVES.includes(out.bestMove), `bestMove must be one of the fixed moves: ${out.bestMove}`);
  assert.equal(typeof out.fitScore, "number");
  assert.ok(out.fitScore >= 0 && out.fitScore <= 100, `fitScore in 0..100: ${out.fitScore}`);
  for (const key of ["collectorType", "summary", "roleInCollection", "tradeoff", "popAlphaRead", "dataBasis"]) {
    assert.equal(typeof out[key], "string", `${key} must be a string`);
    assert.ok(out[key].length > 0, `${key} must be non-empty`);
  }
  assert.ok(["low", "medium", "high"].includes(out.confidence), `confidence enum: ${out.confidence}`);
}

function assertNoHypeNoAdvice(out) {
  const blob = [
    out.summary,
    out.roleInCollection,
    out.tradeoff,
    out.popAlphaRead,
    out.dataBasis,
  ].join(" ").toLowerCase();
  for (const banned of [
    "guaranteed",
    "can't miss",
    "cant miss",
    "you should invest",
    "should invest",
    "strong potential",
    "great addition to any collection",
    "passionate collector",
    "collecting journey",
  ]) {
    assert.ok(!blob.includes(banned), `output must not contain "${banned}": ${blob}`);
  }
}

export async function runCollectorInsightTests() {
  // ── Strong fit: alt-art card × art-first collector with rich data ─────────
  {
    const out = buildCollectorInsightTemplate(ALT_ART_CARD, altArtFeatures(), profile(), richSignals());
    assertContract(out);
    assertNoHypeNoAdvice(out);
    assert.equal(out.source, "template");
    assert.equal(out.confidence, "high");
    // Art-forward aligned card should land a Match (not Weak/Pass) and a high score.
    assert.ok(["Core Match", "Strong Match"].includes(out.fitLabel), `expected a Match label, got ${out.fitLabel}`);
    assert.ok(out.fitScore >= 70, `aligned+high-data should score high: ${out.fitScore}`);
    // Honest tradeoff present even on a strong fit.
    assert.ok(out.tradeoff.length > 10);
    // Data basis references real signals.
    assert.match(out.dataBasis, /saved|watchlist|scanned|Evolving Skies|Crown Zenith/i);
  }

  // ── Weak fit: common card × art-first collector ───────────────────────────
  {
    const out = buildCollectorInsightTemplate(COMMON_CARD, commonFeatures(), profile(), richSignals());
    assertContract(out);
    assertNoHypeNoAdvice(out);
    // A common, illiquid card against an art-first profile should not be Core.
    assert.ok(
      ["Weak Fit", "Style Match", "Pass for Your Profile"].includes(out.fitLabel),
      `common card should not be a strong match: ${out.fitLabel}`,
    );
    assert.ok(out.fitScore <= 65, `weak/neutral fit should not score high: ${out.fitScore}`);
  }

  // ── Thin data: soft framing + low confidence + honest data basis ──────────
  {
    const out = buildCollectorInsightTemplate(ALT_ART_CARD, altArtFeatures(), null, thinSignals());
    assertContract(out);
    assertNoHypeNoAdvice(out);
    assert.equal(out.confidence, "low", "thin data must yield low confidence");
    assert.equal(out.source, "template");
    // Soft framing — must NOT assert certainty.
    assert.match(
      out.summary + " " + out.dataBasis,
      /doesn't have much collection history|early read|appears to fit/i,
    );
    // With a null profile, alignment is neutral → no overclaimed Core Match.
    assert.notEqual(out.fitLabel, "Core Match");
  }

  // ── Deterministic except generated_at ─────────────────────────────────────
  {
    const a = buildCollectorInsightTemplate(ALT_ART_CARD, altArtFeatures(), profile(), richSignals());
    const b = buildCollectorInsightTemplate(ALT_ART_CARD, altArtFeatures(), profile(), richSignals());
    assert.equal(a.fitLabel, b.fitLabel);
    assert.equal(a.fitScore, b.fitScore);
    assert.equal(a.summary, b.summary);
    assert.equal(a.bestMove, b.bestMove);
  }

  console.log("  collector-insight: ok");
}
