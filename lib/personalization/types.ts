/**
 * Shared types for the personalization pipeline.
 *
 * Pipeline: USER BEHAVIOR -> STYLE SCORES -> STYLE SUMMARY -> PERSONALIZED EXPLANATION
 *
 * The LLM never sees raw events — it only consumes structured inputs
 * derived below.
 */

// ── Actor ────────────────────────────────────────────────────────────────────

/**
 * Stable identifier for either a guest or an authenticated user.
 * All personalization data keys off `actor_key`, never directly off Clerk.
 *
 * Format:
 *   - guest: `guest:<uuidv4>`
 *   - user : `user:<clerk_user_id>`
 */
export type ActorKey = string;

export type Actor = {
  /** Stable identifier used for keyed storage. */
  actor_key: ActorKey;
  /** Clerk user id if signed in, otherwise null. */
  clerk_user_id: string | null;
  /** True if this actor is a freshly-minted guest and the cookie must still be written. */
  needs_cookie_set: boolean;
  /** The guest key associated with this signed-in user (if claimed), for UNION reads. */
  claimed_guest_keys: string[];
};

// ── Events ───────────────────────────────────────────────────────────────────

export type EventType =
  | "card_view"
  | "card_search_click"
  | "watchlist_add"
  | "collection_add"
  | "variant_switch"
  | "market_signal_expand"
  | "ai_analysis_expand"
  | "price_history_expand"
  | "compare_open"
  | "portfolio_open";

export type BehaviorEvent = {
  event_type: EventType;
  canonical_slug: string | null;
  printing_id: string | null;
  variant_ref: string | null;
  occurred_at: string; // ISO 8601
  payload: Record<string, unknown>;
};

// ── Card features ────────────────────────────────────────────────────────────

export type EraBucket = "vintage" | "modern" | "contemporary" | "unknown";
export type Band = "low" | "medium" | "high" | "unknown";

export type CardStyleFeatures = {
  canonical_slug: string;
  era: EraBucket;
  release_year: number | null;
  set_name: string | null;
  is_graded: boolean;
  liquidity_band: Band;
  volatility_band: Band;
  is_iconic: boolean;
  is_art_centric: boolean;
  is_mainstream: boolean;
};

// ── Scoring ──────────────────────────────────────────────────────────────────

export type StyleDimension =
  | "vintage_affinity"
  | "modern_affinity"
  | "nostalgia_affinity"
  | "art_affinity"
  | "liquidity_preference"
  | "value_orientation"
  | "momentum_orientation"
  | "raw_preference"
  | "graded_preference"
  | "iconic_character_bias"
  | "set_completion_bias"
  | "volatility_tolerance";

export type StyleScores = Record<StyleDimension, number>;

// ── Profile summary ──────────────────────────────────────────────────────────

export type EvidenceItem = {
  dimension: StyleDimension;
  label: string;
  weight: number;
};

export type StyleProfile = {
  actor_key: ActorKey;
  dominant_style_label: string;
  supporting_traits: string[];
  summary: string;
  confidence: number; // 0..1
  evidence: EvidenceItem[];
  scores: StyleScores;
  event_count: number;
  version: number;
  updated_at: string;
};

// ── Explanation ──────────────────────────────────────────────────────────────

export type PersonalizedExplanation = {
  headline: string;
  summary: string;
  why_it_matches: string;
  reasons: string[];
  caveats: string[];
  confidence: number;
  fits: "aligned" | "neutral" | "contrast";
  generated_at: string;
  // "template" — user is on the template tier by capability, expected outcome.
  // "llm" — LLM call succeeded, generated content.
  // "fallback" — LLM was attempted but failed; the content here is template-
  //   quality but tagged distinctly so telemetry can tell "expected template"
  //   apart from "LLM degraded into template-quality content." See
  //   docs/external-api-failure-modes.md.
  source: "template" | "llm" | "fallback";
  source_version: string;
  // Set only when source === "fallback" — class-level fingerprint of the
  // upstream failure (e.g. "llm-threw:AI_APICallError:…", "parse-miss",
  // "abort"). Visible to the API consumer but its real value is in
  // operational logs and any downstream telemetry that aggregates by
  // failure class.
  failureReason?: string;
};
