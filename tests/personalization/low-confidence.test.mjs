import assert from "node:assert/strict";

import {
  MIN_EVENTS_FOR_EARLY_SIGNAL,
  PROFILE_VERSION,
  STYLE_DIMENSIONS,
} from "@/lib/personalization/constants.ts";
import { buildProfileSummary } from "@/lib/personalization/summary/build-summary.ts";
import { buildTemplateExplanation } from "@/lib/personalization/explanation/template.ts";
import { getCardStyleFeatures } from "@/lib/personalization/features/card-features.ts";

const VINTAGE_CARD = {
  canonical_slug: "charizard-base-set-4",
  canonical_name: "Charizard (Base Set 4)",
  set_name: "Base Set",
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

function zeros() {
  const s = {};
  for (const dim of STYLE_DIMENSIONS) s[dim] = 0;
  return s;
}

export async function runLowConfidenceTests() {
  // ── Profile summary: below-threshold events → zero confidence ─────────────
  {
    const scores = { ...zeros(), vintage_affinity: 0.3 };
    for (const eventCount of [0, 1, 2]) {
      const summary = buildProfileSummary(scores, eventCount);
      assert.equal(summary.confidence, 0, `eventCount ${eventCount} → confidence should be 0`);
      assert.equal(summary.dominant_dimension, null);
      assert.match(summary.summary, /learn your collecting style/i);
    }
  }

  // ── Explanation: fallback when profile null or too thin ──────────────────
  {
    const features = vintageFeatures();

    // No profile at all
    const noProfile = buildTemplateExplanation(VINTAGE_CARD, features, null);
    assert.equal(noProfile.source, "fallback");
    assert.equal(noProfile.confidence, 0);
    assert.match(noProfile.summary, /still learning|stands out|Browse a few more/i);

    // Thin profile
    const thinProfile = {
      actor_key: "guest:x",
      dominant_style_label: "emerging collector",
      supporting_traits: [],
      summary: "",
      confidence: 0.1,
      evidence: [],
      scores: zeros(),
      event_count: MIN_EVENTS_FOR_EARLY_SIGNAL - 1,
      version: PROFILE_VERSION,
      updated_at: new Date().toISOString(),
    };
    const thin = buildTemplateExplanation(VINTAGE_CARD, features, thinProfile);
    assert.equal(thin.source, "fallback");
    assert.equal(thin.fits, "neutral");
  }

  // ── Early-signal profile (exactly at threshold) gets real explanation ────
  {
    const scores = { ...zeros(), vintage_affinity: 0.5, nostalgia_affinity: 0.3 };
    const early = buildProfileSummary(scores, MIN_EVENTS_FOR_EARLY_SIGNAL);
    assert.ok(early.confidence > 0, "at-threshold event count should yield non-zero confidence");
    assert.equal(early.dominant_dimension, "vintage_affinity");
  }

  console.log("  low-confidence: ok");
}
