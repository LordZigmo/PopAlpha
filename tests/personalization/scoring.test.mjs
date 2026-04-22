import assert from "node:assert/strict";

import { STYLE_DIMENSIONS } from "@/lib/personalization/constants.ts";
import { scoreProfile } from "@/lib/personalization/scoring/score.ts";
import { getCardStyleFeatures } from "@/lib/personalization/features/card-features.ts";

const FIXED_NOW = new Date("2026-04-15T12:00:00.000Z");

function isoDaysAgo(days) {
  return new Date(FIXED_NOW.getTime() - days * 86400000).toISOString();
}

function vintageCardFeatures(slug = "charizard-base-set-4") {
  return getCardStyleFeatures(
    {
      canonical_slug: slug,
      set_name: "Base Set",
      release_year: 1999,
      rarity: "Holo Rare",
      card_number: "4",
      finish: "HOLO",
      is_graded: false,
    },
    { active_listings_7d: 25, liquidity_score: 80, volatility_30d: 8 },
  );
}

function modernCardFeatures(slug = "charizard-ex-obsidian-flames-125") {
  return getCardStyleFeatures(
    {
      canonical_slug: slug,
      set_name: "Obsidian Flames",
      release_year: 2023,
      rarity: "Special Illustration Rare",
      card_number: "215",
      finish: "HOLO",
      is_graded: false,
    },
    { active_listings_7d: 40, liquidity_score: 90, volatility_30d: 30 },
  );
}

function gradedCardFeatures(slug = "pikachu-illustrator-promo") {
  return getCardStyleFeatures(
    {
      canonical_slug: slug,
      set_name: "Promo",
      release_year: 1998,
      rarity: "Secret Rare",
      card_number: "1",
      finish: "HOLO",
      is_graded: true,
    },
    { active_listings_7d: 3, liquidity_score: 15, volatility_30d: 30 },
  );
}

function mapResolver(entries) {
  return (slug) => (slug ? entries.get(slug) ?? null : null);
}

export async function runScoringTests() {
  // ── Empty input stability ─────────────────────────────────────────────────
  {
    const scores = scoreProfile([], () => null, FIXED_NOW);
    for (const dim of STYLE_DIMENSIONS) {
      assert.equal(scores[dim], 0, `empty input must yield 0 for ${dim}`);
    }
  }

  // ── Normalization clamps to 0..1 ───────────────────────────────────────────
  {
    const events = Array.from({ length: 50 }, (_, i) => ({
      event_type: "card_view",
      canonical_slug: "charizard-base-set-4",
      printing_id: null,
      variant_ref: null,
      occurred_at: isoDaysAgo(0.01 + i * 0.001),
      payload: {},
    }));
    const features = vintageCardFeatures();
    const resolver = mapResolver(new Map([[features.canonical_slug, features]]));
    const scores = scoreProfile(events, resolver, FIXED_NOW);
    for (const dim of STYLE_DIMENSIONS) {
      assert.ok(scores[dim] >= 0 && scores[dim] <= 1, `${dim} out of [0,1]: ${scores[dim]}`);
    }
    // Should strongly score vintage affinity.
    assert.ok(scores.vintage_affinity > 0.8, `vintage_affinity should saturate with heavy signal, got ${scores.vintage_affinity}`);
  }

  // ── Recency decay ──────────────────────────────────────────────────────────
  {
    const features = vintageCardFeatures();
    const resolver = mapResolver(new Map([[features.canonical_slug, features]]));

    const freshEvent = {
      event_type: "card_view",
      canonical_slug: features.canonical_slug,
      printing_id: null,
      variant_ref: null,
      occurred_at: isoDaysAgo(0),
      payload: {},
    };
    const oldEvent = {
      ...freshEvent,
      occurred_at: isoDaysAgo(120), // >3 half-lives → ~0.125x weight
    };

    const freshScores = scoreProfile([freshEvent, freshEvent, freshEvent], resolver, FIXED_NOW);
    const staleScores = scoreProfile([oldEvent, oldEvent, oldEvent], resolver, FIXED_NOW);
    assert.ok(
      freshScores.vintage_affinity > staleScores.vintage_affinity,
      `recency must reduce signal: fresh ${freshScores.vintage_affinity} vs stale ${staleScores.vintage_affinity}`,
    );
  }

  // ── Contrast: vintage events vs modern events diverge ──────────────────────
  {
    const vintage = vintageCardFeatures();
    const modern = modernCardFeatures();
    const resolver = mapResolver(
      new Map([
        [vintage.canonical_slug, vintage],
        [modern.canonical_slug, modern],
      ]),
    );
    const vintageEvents = Array.from({ length: 6 }, (_, i) => ({
      event_type: "card_view",
      canonical_slug: vintage.canonical_slug,
      printing_id: null,
      variant_ref: null,
      occurred_at: isoDaysAgo(i),
      payload: {},
    }));
    const modernEvents = Array.from({ length: 6 }, (_, i) => ({
      event_type: "card_view",
      canonical_slug: modern.canonical_slug,
      printing_id: null,
      variant_ref: null,
      occurred_at: isoDaysAgo(i),
      payload: {},
    }));
    const v = scoreProfile(vintageEvents, resolver, FIXED_NOW);
    const m = scoreProfile(modernEvents, resolver, FIXED_NOW);
    assert.ok(v.vintage_affinity > m.vintage_affinity, `vintage events should drive vintage_affinity higher`);
    assert.ok(m.modern_affinity > v.modern_affinity, `modern events should drive modern_affinity higher`);
  }

  // ── Graded vs raw preference from variant_switch ───────────────────────────
  {
    const events = [
      {
        event_type: "variant_switch",
        canonical_slug: "pikachu-illustrator-promo",
        printing_id: null,
        variant_ref: "p1::PSA::G10",
        occurred_at: isoDaysAgo(1),
        payload: {},
      },
      {
        event_type: "variant_switch",
        canonical_slug: "pikachu-illustrator-promo",
        printing_id: null,
        variant_ref: "p1::PSA::G9",
        occurred_at: isoDaysAgo(2),
        payload: {},
      },
    ];
    const graded = gradedCardFeatures();
    const resolver = mapResolver(new Map([[graded.canonical_slug, graded]]));
    const scores = scoreProfile(events, resolver, FIXED_NOW);
    assert.ok(scores.graded_preference > scores.raw_preference, `graded variant switches should push graded_preference higher`);
  }

  // ── Volatility tolerance rises with high-volatility modern card views ──────
  {
    const modern = modernCardFeatures();
    const resolver = mapResolver(new Map([[modern.canonical_slug, modern]]));
    const events = Array.from({ length: 8 }, (_, i) => ({
      event_type: "card_view",
      canonical_slug: modern.canonical_slug,
      printing_id: null,
      variant_ref: null,
      occurred_at: isoDaysAgo(i * 0.5),
      payload: {},
    }));
    const scores = scoreProfile(events, resolver, FIXED_NOW);
    assert.ok(scores.volatility_tolerance > 0, `high-volatility cards should produce volatility_tolerance signal`);
    assert.ok(scores.art_affinity > 0, `Special Illustration Rare cards should produce art_affinity signal`);
  }

  // ── Set completion bias — repeat set visits add up ─────────────────────────
  {
    const features = vintageCardFeatures();
    const resolver = mapResolver(new Map([[features.canonical_slug, features]]));
    const events = Array.from({ length: 5 }, (_, i) => ({
      event_type: "card_view",
      canonical_slug: features.canonical_slug,
      printing_id: null,
      variant_ref: null,
      occurred_at: isoDaysAgo(i),
      payload: {},
    }));
    const scores = scoreProfile(events, resolver, FIXED_NOW);
    assert.ok(scores.set_completion_bias > 0, `same-set repetition should produce set_completion_bias`);
  }

  console.log("  scoring: ok");
}
