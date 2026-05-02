import type { EventType, StyleDimension } from "./types";

/** All accepted event_type strings. Mirrors the DB CHECK constraint. */
export const EVENT_TYPES: readonly EventType[] = [
  "card_view",
  "card_search_click",
  "watchlist_add",
  "collection_add",
  "variant_switch",
  "market_signal_expand",
  "ai_analysis_expand",
  "ai_brief_read_more_tapped",
  "price_history_expand",
  "compare_open",
  "portfolio_open",
] as const;

export const STYLE_DIMENSIONS: readonly StyleDimension[] = [
  "vintage_affinity",
  "modern_affinity",
  "nostalgia_affinity",
  "art_affinity",
  "liquidity_preference",
  "value_orientation",
  "momentum_orientation",
  "raw_preference",
  "graded_preference",
  "iconic_character_bias",
  "set_completion_bias",
  "volatility_tolerance",
] as const;

/** Minimum event count before the profile is considered fully confident. */
export const MIN_EVENTS_FOR_CONFIDENT_PROFILE = 20;
/** Minimum event count before we surface any personalized signal at all. */
export const MIN_EVENTS_FOR_EARLY_SIGNAL = 3;

/** Exponential recency decay half-life in days. */
export const RECENCY_HALF_LIFE_DAYS = 30;

/** Bumped whenever the scoring or summary shape changes. Triggers cache invalidation. */
export const PROFILE_VERSION = 1;

/** Max events per ingest call (batch cap). */
export const MAX_EVENTS_PER_INGEST = 50;

/** Max byte size of a single event payload. */
export const MAX_PAYLOAD_BYTES = 2048;

/** Event weights per dimension. Higher-intent actions weigh more than passive views. */
export const EVENT_WEIGHTS: Record<EventType, number> = {
  card_view: 1,
  card_search_click: 1.2,
  watchlist_add: 4,
  collection_add: 5,
  variant_switch: 1.8,
  market_signal_expand: 2,
  ai_analysis_expand: 2,
  // Lighter than ai_analysis_expand because the brief is market-wide,
  // not card-specific — it tells us the user is engaged with macro
  // commentary, but doesn't pin a style dimension the way expanding
  // a per-card AI takeaway does.
  ai_brief_read_more_tapped: 1.2,
  price_history_expand: 2,
  compare_open: 2.5,
  portfolio_open: 1.2,
};

/** Canonical label per dominant dimension. Keep the tone observational. */
export const DOMINANT_LABELS: Record<StyleDimension, string> = {
  vintage_affinity: "vintage-leaning collector",
  modern_affinity: "modern-set focused collector",
  nostalgia_affinity: "nostalgia-driven collector",
  art_affinity: "art-first collector",
  liquidity_preference: "liquidity-conscious collector",
  value_orientation: "value-oriented collector",
  momentum_orientation: "momentum-aware collector",
  raw_preference: "raw-focused collector",
  graded_preference: "graded-focused collector",
  iconic_character_bias: "iconic-character hunter",
  set_completion_bias: "set completionist",
  volatility_tolerance: "volatility-tolerant collector",
};

/** Short human-readable label shown in evidence bullets and trait lists. */
export const TRAIT_LABELS: Record<StyleDimension, string> = {
  vintage_affinity: "vintage-leaning",
  modern_affinity: "modern-focused",
  nostalgia_affinity: "nostalgia-driven",
  art_affinity: "art-first",
  liquidity_preference: "liquidity-conscious",
  value_orientation: "value-oriented",
  momentum_orientation: "momentum-aware",
  raw_preference: "raw-focused",
  graded_preference: "graded-focused",
  iconic_character_bias: "iconic-character",
  set_completion_bias: "set-completion",
  volatility_tolerance: "volatility-tolerant",
};
