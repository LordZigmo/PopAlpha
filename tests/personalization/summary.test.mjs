import assert from "node:assert/strict";

import { STYLE_DIMENSIONS, MIN_EVENTS_FOR_EARLY_SIGNAL, MIN_EVENTS_FOR_CONFIDENT_PROFILE } from "@/lib/personalization/constants.ts";
import { buildProfileSummary, computeConfidence, pickSupportingTraits, rankedDimensions } from "@/lib/personalization/summary/build-summary.ts";

function zeros() {
  const s = {};
  for (const dim of STYLE_DIMENSIONS) s[dim] = 0;
  return s;
}

function withScores(overrides) {
  return { ...zeros(), ...overrides };
}

export async function runSummaryTests() {
  // ── Low signal → neutral, zero confidence ─────────────────────────────────
  {
    const scores = withScores({ vintage_affinity: 0.1 });
    const s = buildProfileSummary(scores, 1);
    assert.equal(s.confidence, 0, `event_count below MIN_EVENTS_FOR_EARLY_SIGNAL must give 0 confidence`);
    assert.equal(s.dominant_dimension, null);
    assert.equal(s.dominant_style_label, "emerging collector");
  }

  // ── Dominant label matches top dimension ──────────────────────────────────
  {
    const scores = withScores({
      vintage_affinity: 0.8,
      nostalgia_affinity: 0.4,
      iconic_character_bias: 0.3,
      modern_affinity: 0.05,
    });
    const s = buildProfileSummary(scores, MIN_EVENTS_FOR_CONFIDENT_PROFILE);
    assert.equal(s.dominant_dimension, "vintage_affinity");
    assert.match(s.dominant_style_label, /vintage-leaning/);
    assert.match(s.summary, /vintage/);
    assert.ok(s.supporting_traits.length >= 1, "should surface 1-3 supporting traits");
    assert.ok(s.supporting_traits.length <= 3, "should surface at most 3 supporting traits");
    assert.ok(
      s.evidence.every((e) => e.weight > 0),
      "evidence should only include positive-weight dimensions",
    );
  }

  // ── Confidence scales with evidence ───────────────────────────────────────
  {
    const scores = withScores({ vintage_affinity: 0.5, modern_affinity: 0.1 });
    const lowEvidence = computeConfidence(scores, MIN_EVENTS_FOR_EARLY_SIGNAL);
    const midEvidence = computeConfidence(scores, Math.floor(MIN_EVENTS_FOR_CONFIDENT_PROFILE / 2));
    const fullEvidence = computeConfidence(scores, MIN_EVENTS_FOR_CONFIDENT_PROFILE);
    assert.ok(lowEvidence < midEvidence, "midEvidence should exceed lowEvidence");
    assert.ok(midEvidence < fullEvidence, "fullEvidence should exceed midEvidence");
    assert.ok(fullEvidence > 0 && fullEvidence <= 1, "confidence must stay in [0,1]");
  }

  // ── Supporting traits skip the dominant ───────────────────────────────────
  {
    const scores = withScores({
      vintage_affinity: 0.7,
      nostalgia_affinity: 0.5,
      iconic_character_bias: 0.3,
    });
    const traits = pickSupportingTraits(scores, "vintage_affinity");
    assert.ok(!traits.includes("vintage-leaning"), "dominant trait must be excluded");
    assert.ok(traits.includes("nostalgia-driven"));
  }

  // ── Ranked ordering is strictly by score desc ─────────────────────────────
  {
    const scores = withScores({ vintage_affinity: 0.2, modern_affinity: 0.6, art_affinity: 0.4 });
    const ranked = rankedDimensions(scores, 3);
    assert.equal(ranked[0], "modern_affinity");
    assert.equal(ranked[1], "art_affinity");
    assert.equal(ranked[2], "vintage_affinity");
  }

  // ── Persona coherence: each persona's dominant label matches expectation ──
  const personas = [
    { name: "vintage-leaning", scores: withScores({ vintage_affinity: 0.8, nostalgia_affinity: 0.4 }), expect: /vintage-leaning/ },
    { name: "modern", scores: withScores({ modern_affinity: 0.8, momentum_orientation: 0.4 }), expect: /modern-set focused/ },
    { name: "art-first", scores: withScores({ art_affinity: 0.85, modern_affinity: 0.3 }), expect: /art-first/ },
    { name: "liquidity-conscious", scores: withScores({ liquidity_preference: 0.8, value_orientation: 0.4 }), expect: /liquidity-conscious/ },
    { name: "set-completionist", scores: withScores({ set_completion_bias: 0.8 }), expect: /set completionist/ },
  ];
  for (const persona of personas) {
    const s = buildProfileSummary(persona.scores, MIN_EVENTS_FOR_CONFIDENT_PROFILE);
    assert.match(s.dominant_style_label, persona.expect, `${persona.name} persona label mismatch: ${s.dominant_style_label}`);
  }

  console.log("  summary: ok");
}
