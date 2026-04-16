/**
 * Card feature extraction.
 *
 * Pure function — no DB, no side effects. Converts a canonical card row plus
 * optional market metrics into a compact structured feature set the scoring
 * engine can reason about.
 */

import type { Band, CardStyleFeatures, EraBucket } from "../types";

// ── Inputs ───────────────────────────────────────────────────────────────────

export type CardFeatureInput = {
  canonical_slug: string;
  set_name: string | null;
  release_year: number | null;
  rarity: string | null;
  card_number: string | null;
  finish: string | null;
  is_graded: boolean;
};

export type CardMetricsInput = {
  active_listings_7d: number | null;
  liquidity_score: number | null; // 0..100
  volatility_30d: number | null; // higher = more volatile
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function eraFromYear(year: number | null | undefined): EraBucket {
  if (year == null || !Number.isFinite(year)) return "unknown";
  if (year <= 2003) return "vintage";
  if (year <= 2016) return "modern";
  return "contemporary";
}

function liquidityBand(metrics: CardMetricsInput): Band {
  if (metrics.liquidity_score != null && Number.isFinite(metrics.liquidity_score)) {
    if (metrics.liquidity_score >= 66) return "high";
    if (metrics.liquidity_score >= 33) return "medium";
    return "low";
  }
  const listings = metrics.active_listings_7d;
  if (listings == null) return "unknown";
  if (listings >= 20) return "high";
  if (listings >= 5) return "medium";
  return "low";
}

function volatilityBand(metrics: CardMetricsInput): Band {
  const v = metrics.volatility_30d;
  if (v == null || !Number.isFinite(v)) return "unknown";
  // Values are % stdev; conservative buckets.
  if (v >= 25) return "high";
  if (v >= 10) return "medium";
  return "low";
}

// Keywords that signal "iconic character" when combined with rarity or low card number.
const ICONIC_CHARACTER_KEYWORDS = [
  "charizard",
  "pikachu",
  "mewtwo",
  "mew",
  "lugia",
  "rayquaza",
  "umbreon",
  "eevee",
  "gengar",
  "dragonite",
  "blastoise",
  "venusaur",
];

function isIconic(input: CardFeatureInput): boolean {
  const slug = (input.canonical_slug ?? "").toLowerCase();
  const nameHit = ICONIC_CHARACTER_KEYWORDS.some((kw) => slug.includes(kw));
  if (!nameHit) return false;
  // Additional signal: low card number tends to indicate holo/rares of the iconic pokemon.
  const cardNumInt = Number.parseInt((input.card_number ?? "").replace(/\D+/g, ""), 10);
  const lowNumber = Number.isFinite(cardNumInt) && cardNumInt > 0 && cardNumInt <= 50;
  const rareRarity = (input.rarity ?? "").toLowerCase().includes("holo")
    || (input.rarity ?? "").toLowerCase().includes("rare")
    || (input.rarity ?? "").toLowerCase().includes("ultra")
    || (input.rarity ?? "").toLowerCase().includes("secret");
  return lowNumber || rareRarity;
}

function isArtCentric(input: CardFeatureInput): boolean {
  const rarity = (input.rarity ?? "").toLowerCase();
  return (
    rarity.includes("art rare")
    || rarity.includes("illustration rare")
    || rarity.includes("special illustration")
    || rarity.includes("alt art")
    || rarity.includes("full art")
  );
}

function isMainstream(input: CardFeatureInput, metrics: CardMetricsInput): boolean {
  const liquidity = liquidityBand(metrics);
  const slug = (input.canonical_slug ?? "").toLowerCase();
  const keywordHit = ICONIC_CHARACTER_KEYWORDS.some((kw) => slug.includes(kw));
  return keywordHit && (liquidity === "medium" || liquidity === "high");
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function getCardStyleFeatures(
  card: CardFeatureInput,
  metrics: CardMetricsInput = {
    active_listings_7d: null,
    liquidity_score: null,
    volatility_30d: null,
  },
): CardStyleFeatures {
  return {
    canonical_slug: card.canonical_slug,
    era: eraFromYear(card.release_year),
    release_year: card.release_year ?? null,
    set_name: card.set_name ?? null,
    is_graded: !!card.is_graded,
    liquidity_band: liquidityBand(metrics),
    volatility_band: volatilityBand(metrics),
    is_iconic: isIconic(card),
    is_art_centric: isArtCentric(card),
    is_mainstream: isMainstream(card, metrics),
  };
}
