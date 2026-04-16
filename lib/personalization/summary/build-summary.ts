/**
 * Profile summary builder.
 *
 * Takes raw style scores + event_count and produces a compact structured
 * summary: dominant label, 3 supporting traits, observational summary string,
 * confidence value, and evidence bullets.
 */

import {
  DOMINANT_LABELS,
  MIN_EVENTS_FOR_CONFIDENT_PROFILE,
  MIN_EVENTS_FOR_EARLY_SIGNAL,
  STYLE_DIMENSIONS,
  TRAIT_LABELS,
} from "../constants";
import type {
  EvidenceItem,
  StyleDimension,
  StyleScores,
} from "../types";

export type ProfileSummary = {
  dominant_style_label: string;
  supporting_traits: string[];
  summary: string;
  confidence: number;
  evidence: EvidenceItem[];
  dominant_dimension: StyleDimension | null;
};

/** Rank dimensions by score desc. Returns up to `n`. */
export function rankedDimensions(scores: StyleScores, n = STYLE_DIMENSIONS.length): StyleDimension[] {
  return [...STYLE_DIMENSIONS]
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, n);
}

/**
 * Confidence is a blend of:
 *   - how much evidence we have (event_count vs. the confident threshold), and
 *   - how sharply one dimension dominates the next (score separation).
 *
 * Returns 0..1.
 */
export function computeConfidence(scores: StyleScores, eventCount: number): number {
  if (eventCount < MIN_EVENTS_FOR_EARLY_SIGNAL) return 0;
  const evidenceFactor = Math.min(
    1,
    eventCount / Math.max(1, MIN_EVENTS_FOR_CONFIDENT_PROFILE),
  );
  const ranked = rankedDimensions(scores, 2);
  const top = scores[ranked[0]] ?? 0;
  const second = scores[ranked[1]] ?? 0;
  const separation = Math.max(0, top - second);
  const peakFactor = Math.min(1, top);
  const separationFactor = Math.min(1, separation * 3);
  // Weighted blend — evidence dominates early, separation kicks in once we
  // have enough events.
  const raw = 0.55 * evidenceFactor + 0.25 * peakFactor + 0.2 * separationFactor;
  return Math.max(0, Math.min(1, raw));
}

function observationalSentence(dim: StyleDimension | null, eventCount: number): string {
  if (!dim || eventCount < MIN_EVENTS_FOR_EARLY_SIGNAL) {
    return "We'll learn your collecting style as you browse.";
  }
  switch (dim) {
    case "vintage_affinity":
      return "Your activity suggests you favor vintage-era cards.";
    case "modern_affinity":
      return "Your activity leans toward modern and contemporary sets.";
    case "nostalgia_affinity":
      return "You tend to gravitate toward nostalgic, era-anchored cards.";
    case "art_affinity":
      return "You tend to favor art-forward cards like Illustration Rares and alt arts.";
    case "liquidity_preference":
      return "You tend to engage with cards that have active, liquid markets.";
    case "value_orientation":
      return "Your activity suggests a value-first lens on cards.";
    case "momentum_orientation":
      return "You tend to pay attention to momentum and price movement.";
    case "raw_preference":
      return "You tend to focus on raw-ungraded pricing and condition.";
    case "graded_preference":
      return "You tend to focus on graded-card pricing and pop.";
    case "iconic_character_bias":
      return "You tend to gravitate toward iconic-character cards.";
    case "set_completion_bias":
      return "Your activity suggests a set-completion focus.";
    case "volatility_tolerance":
      return "You tend to engage with more volatile, higher-variance cards.";
  }
}

/** Observational traits are the next 3 dimensions under the dominant one. */
export function pickSupportingTraits(
  scores: StyleScores,
  dominant: StyleDimension | null,
  minScore = 0.1,
): string[] {
  const ranked = rankedDimensions(scores, STYLE_DIMENSIONS.length);
  const out: string[] = [];
  for (const dim of ranked) {
    if (dim === dominant) continue;
    if (scores[dim] < minScore) break;
    out.push(TRAIT_LABELS[dim]);
    if (out.length >= 3) break;
  }
  return out;
}

export function buildProfileSummary(
  scores: StyleScores,
  eventCount: number,
): ProfileSummary {
  const confidence = computeConfidence(scores, eventCount);
  const ranked = rankedDimensions(scores);
  const dominant = eventCount >= MIN_EVENTS_FOR_EARLY_SIGNAL && scores[ranked[0]] > 0
    ? ranked[0]
    : null;

  const summary = observationalSentence(dominant, eventCount);
  const dominantLabel = dominant ? DOMINANT_LABELS[dominant] : "emerging collector";
  const supportingTraits = pickSupportingTraits(scores, dominant);
  const evidence: EvidenceItem[] = ranked
    .filter((dim) => scores[dim] > 0)
    .slice(0, 5)
    .map((dim) => ({
      dimension: dim,
      label: TRAIT_LABELS[dim],
      weight: Number(scores[dim].toFixed(3)),
    }));

  return {
    dominant_style_label: dominantLabel,
    supporting_traits: supportingTraits,
    summary,
    confidence,
    evidence,
    dominant_dimension: dominant,
  };
}
