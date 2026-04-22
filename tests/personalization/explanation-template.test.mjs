import assert from "node:assert/strict";

import { STYLE_DIMENSIONS, PROFILE_VERSION } from "@/lib/personalization/constants.ts";
import { buildTemplateExplanation, computeAlignment } from "@/lib/personalization/explanation/template.ts";
import { getCardStyleFeatures } from "@/lib/personalization/features/card-features.ts";

function zeros() {
  const s = {};
  for (const dim of STYLE_DIMENSIONS) s[dim] = 0;
  return s;
}

function profile(overrides = {}) {
  return {
    actor_key: "guest:test",
    dominant_style_label: "vintage-leaning collector",
    supporting_traits: ["nostalgia-driven", "iconic-character"],
    summary: "Your activity suggests you favor vintage-era cards.",
    confidence: 0.7,
    evidence: [],
    scores: { ...zeros(), vintage_affinity: 0.8, nostalgia_affinity: 0.5, iconic_character_bias: 0.4 },
    event_count: 30,
    version: PROFILE_VERSION,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const VINTAGE_CARD = {
  canonical_slug: "charizard-base-set-4",
  canonical_name: "Charizard (Base Set 4)",
  set_name: "Base Set",
};

const MODERN_CARD = {
  canonical_slug: "charizard-ex-215",
  canonical_name: "Charizard ex 215",
  set_name: "Obsidian Flames",
};

function vintageFeatures() {
  return getCardStyleFeatures(
    {
      canonical_slug: VINTAGE_CARD.canonical_slug,
      set_name: VINTAGE_CARD.set_name,
      release_year: 1999,
      rarity: "Holo Rare",
      card_number: "4",
      finish: "HOLO",
      is_graded: false,
    },
    { active_listings_7d: 25, liquidity_score: 80, volatility_30d: 8 },
  );
}

function modernFeatures() {
  return getCardStyleFeatures(
    {
      canonical_slug: MODERN_CARD.canonical_slug,
      set_name: MODERN_CARD.set_name,
      release_year: 2023,
      rarity: "Special Illustration Rare",
      card_number: "215",
      finish: "HOLO",
      is_graded: false,
    },
    { active_listings_7d: 40, liquidity_score: 90, volatility_30d: 30 },
  );
}

export async function runExplanationTemplateTests() {
  // ── Fallback when profile is null ─────────────────────────────────────────
  {
    const features = vintageFeatures();
    const out = buildTemplateExplanation(VINTAGE_CARD, features, null);
    assert.equal(out.source, "fallback");
    assert.equal(out.confidence, 0);
    assert.equal(out.fits, "neutral");
    assert.ok(out.reasons.length >= 1);
  }

  // ── Fallback when profile has too few events ──────────────────────────────
  {
    const features = vintageFeatures();
    const out = buildTemplateExplanation(VINTAGE_CARD, features, profile({ event_count: 1 }));
    assert.equal(out.source, "fallback");
  }

  // ── Aligned: vintage card × vintage profile ──────────────────────────────
  {
    const features = vintageFeatures();
    const p = profile();
    const alignment = computeAlignment(features, p);
    assert.equal(alignment.fits, "aligned");
    const out = buildTemplateExplanation(VINTAGE_CARD, features, p);
    assert.equal(out.source, "template");
    assert.equal(out.fits, "aligned");
    assert.match(out.headline, /fits/i);
    assert.match(out.summary, /vintage/);
    assert.ok(out.reasons.length >= 1 && out.reasons.length <= 4);
  }

  // ── Contrast: modern card × vintage profile ──────────────────────────────
  {
    const features = modernFeatures();
    const vintageProfile = profile(); // vintage-leaning
    const alignment = computeAlignment(features, vintageProfile);
    assert.equal(alignment.fits, "contrast");
    const out = buildTemplateExplanation(MODERN_CARD, features, vintageProfile);
    assert.equal(out.fits, "contrast");
    assert.match(out.headline, /outside/i);
    // Must include contrast language that acknowledges interest is still possible.
    assert.match(out.summary, /interesting/i);
  }

  // ── Deterministic except for generated_at ─────────────────────────────────
  {
    const features = vintageFeatures();
    const p = profile();
    const a = buildTemplateExplanation(VINTAGE_CARD, features, p);
    const b = buildTemplateExplanation(VINTAGE_CARD, features, p);
    assert.equal(a.headline, b.headline);
    assert.equal(a.summary, b.summary);
    assert.deepEqual(a.reasons, b.reasons);
    assert.equal(a.fits, b.fits);
  }

  // ── Never produces buy/sell/investment language ───────────────────────────
  {
    const features = modernFeatures();
    const p = profile();
    const out = buildTemplateExplanation(MODERN_CARD, features, p);
    const blob = [out.headline, out.summary, out.why_it_matches, ...out.reasons, ...out.caveats].join(" ").toLowerCase();
    for (const banned of ["buy", "sell", "invest", "should purchase", "strong buy", "accumulate", "trim"]) {
      assert.ok(!blob.includes(banned), `output must not contain "${banned}": ${blob}`);
    }
  }

  console.log("  explanation-template: ok");
}
