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
  | "ai_brief_read_more_tapped"
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

// ── Collector Insight ──────────────────────────────────────────────────────

/**
 * The Collector Insight is USER-centered, not card-centered. It answers ONE
 * question: "Given the kind of collector this user is, should this specific
 * card matter to them?" — and is deliberately distinct from the card-centered
 * Market Brief (`card_profiles` / homepage brief), which it must not duplicate.
 *
 * This is the structured replacement for the loose `PersonalizedExplanation`
 * shape. It is emitted on the `collectorInsight` key (kept distinct from the
 * legacy `explanation` key) and iOS implements the exact same contract.
 *
 * The shape is intentionally a fixed set of fields (not one prose blob) so the
 * client can lay out fit label, score, role, tradeoff, and best move as
 * structured UI rather than parsing a paragraph.
 */
export type CollectorFitLabel =
  | "Core Match"
  | "Strong Match"
  | "Speculative Match"
  | "Emotional Match"
  | "Completion Match"
  | "Style Match"
  | "Weak Fit"
  | "Pass for Your Profile";

export type CollectorBestMove =
  | "Buy"
  | "Watch"
  | "Hold"
  | "Grade"
  | "Sell"
  | "Pass"
  | "Buy only below recent support"
  | "Keep as a long-term collection piece";

export const COLLECTOR_FIT_LABELS: readonly CollectorFitLabel[] = [
  "Core Match",
  "Strong Match",
  "Speculative Match",
  "Emotional Match",
  "Completion Match",
  "Style Match",
  "Weak Fit",
  "Pass for Your Profile",
] as const;

export const COLLECTOR_BEST_MOVES: readonly CollectorBestMove[] = [
  "Buy",
  "Watch",
  "Hold",
  "Grade",
  "Sell",
  "Pass",
  "Buy only below recent support",
  "Keep as a long-term collection piece",
] as const;

export type CollectorInsight = {
  /** One of the fixed fit labels. */
  fitLabel: CollectorFitLabel;
  /** 0–100. How strongly this card fits the user's collector profile. */
  fitScore: number;
  /** The determined collector type (e.g. "Art-Driven Collector"). */
  collectorType: string;
  /** Why this card fits or does not fit this user. */
  summary: string;
  /** The role this card would play in the user's collection. */
  roleInCollection: string;
  /** The honest tradeoff — never hype-only. */
  tradeoff: string;
  /** One of the fixed best-move options. */
  bestMove: CollectorBestMove;
  /** One memorable, opinionated final read. */
  popAlphaRead: string;
  /** Self-reported certainty given how much user data informed the read. */
  confidence: "low" | "medium" | "high";
  /** Brief note on what user data informed this (e.g. "based on your scans"). */
  dataBasis: string;
  // ── Provenance (not part of the public client contract, but useful for
  //    telemetry and the silent-fallback discipline). The client may ignore
  //    these; they are never load-bearing for display. ──
  generated_at: string;
  // "llm" — structured LLM call succeeded.
  // "template" — deterministic build (template tier, or thin data by design).
  // "fallback" — LLM was attempted but failed; content is template-quality but
  //   tagged distinctly so telemetry separates "expected template" from
  //   "LLM degraded". See docs/external-api-failure-modes.md.
  source: "template" | "llm" | "fallback";
  source_version: string;
  // Set only when source === "fallback". Class-level failure fingerprint
  // ("parse-miss", "llm-threw:<name>:<msg>", "llm-import-or-unexpected:…").
  failureReason?: string;
};

/**
 * Assembled user-collection signals fed to the Collector Insight prompt.
 *
 * These are derived from the actor's behavior-event stream (saved /
 * watchlisted / scanned cards, repeatedly-viewed cards, graded-vs-raw
 * engagement, JP-vs-EN engagement) and the computed style profile. The LLM
 * never sees raw events — only this structured digest.
 *
 * Every field is "best-effort": when a signal is absent we leave the array
 * empty / the count zero rather than inventing one. The prompt reads
 * `dataConfidence` to decide whether to use soft, early-read framing.
 */
export type CollectorSignals = {
  /** Determined collector type label (from the style profile). */
  collectorType: string;
  /** Supporting trait labels, most-salient first. */
  supportingTraits: string[];
  /** 0..1 profile confidence (drives soft framing when low). */
  profileConfidence: number;
  /** Total behavior events on record for this actor. */
  eventCount: number;
  /** Card names the user saved to their collection (most recent first). */
  savedCardNames: string[];
  /** Card names the user added to a watchlist. */
  watchlistCardNames: string[];
  /** Card names the user scanned. */
  scannedCardNames: string[];
  /** Card names the user viewed repeatedly (>1 view). */
  repeatedlyViewedCardNames: string[];
  /** Sets the user has spent the most time in (most-engaged first). */
  favoriteSets: string[];
  /** "graded" | "raw" | "mixed" | "unknown" — inferred from variant engagement. */
  gradedVsRawInterest: "graded" | "raw" | "mixed" | "unknown";
  /** "jp" | "en" | "mixed" | "unknown" — inferred from engaged cards. */
  languagePreference: "jp" | "en" | "mixed" | "unknown";
  /**
   * Coarse self-assessment of how much collection history we have, used by
   * the prompt to pick framing and by the deterministic builder to pick a
   * confidence band. "none" → no personal signal at all.
   */
  dataConfidence: "none" | "low" | "medium" | "high";
};
