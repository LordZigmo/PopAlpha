/**
 * V1 scoring engine.
 *
 * Deterministic, heuristic, no ML. Each behavior event contributes weighted
 * signal to one or more style dimensions, with exponential recency decay.
 * Scores are clamped to [0, 1].
 *
 * Tuning knobs live in `../constants.ts` — avoid magic numbers here.
 */

import {
  EVENT_WEIGHTS,
  RECENCY_HALF_LIFE_DAYS,
  STYLE_DIMENSIONS,
} from "../constants";
import type {
  BehaviorEvent,
  CardStyleFeatures,
  StyleDimension,
  StyleScores,
} from "../types";

export type CardFeatureResolver = (
  canonical_slug: string | null,
  variant_ref: string | null,
) => CardStyleFeatures | null;

function emptyScores(): StyleScores {
  const out: Partial<StyleScores> = {};
  for (const dim of STYLE_DIMENSIONS) out[dim] = 0;
  return out as StyleScores;
}

function recencyMultiplier(occurredAt: string, now: Date): number {
  const t = new Date(occurredAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const diffDays = Math.max(0, (now.getTime() - t) / (24 * 60 * 60 * 1000));
  // Exponential decay with configured half-life.
  return Math.pow(0.5, diffDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Map a single event + its card features into dimension deltas.
 * Deltas are raw (pre-normalization, pre-recency) and are summed across all events.
 *
 * Weights here are intentionally coarse — fine-tuning can happen once we have
 * real signal about which dimensions over- or underfit.
 */
function dimensionDeltas(
  event: BehaviorEvent,
  features: CardStyleFeatures | null,
): Partial<Record<StyleDimension, number>> {
  const eventWeight = EVENT_WEIGHTS[event.event_type] ?? 1;
  const deltas: Partial<Record<StyleDimension, number>> = {};

  function add(dim: StyleDimension, amount: number) {
    deltas[dim] = (deltas[dim] ?? 0) + amount * eventWeight;
  }

  // Some signal is derivable without features (variant and expand events).
  if (event.event_type === "variant_switch") {
    const ref = event.variant_ref ?? "";
    if (ref.includes("::RAW")) add("raw_preference", 1);
    else if (/(::PSA|::CGC|::BGS|::TAG)/i.test(ref)) add("graded_preference", 1);
  }

  if (event.event_type === "price_history_expand") add("momentum_orientation", 0.5);
  if (event.event_type === "market_signal_expand") {
    add("momentum_orientation", 0.3);
    add("liquidity_preference", 0.3);
  }
  if (event.event_type === "ai_analysis_expand") add("value_orientation", 0.3);
  if (event.event_type === "compare_open") add("value_orientation", 0.4);

  if (!features) return deltas;

  // Era → vintage vs modern affinity.
  if (features.era === "vintage") add("vintage_affinity", 1);
  if (features.era === "modern") add("modern_affinity", 0.6);
  if (features.era === "contemporary") add("modern_affinity", 1);

  // Vintage era also tends to carry nostalgia weight.
  if (features.era === "vintage") add("nostalgia_affinity", 0.8);

  // Iconic / art-centric.
  if (features.is_iconic) {
    add("iconic_character_bias", 1);
    add("nostalgia_affinity", 0.3);
  }
  if (features.is_art_centric) add("art_affinity", 1);

  // Graded vs raw — engagement with graded variant bumps graded preference.
  if (features.is_graded) add("graded_preference", 0.7);
  else add("raw_preference", 0.4);

  // Liquidity / volatility bands.
  if (features.liquidity_band === "high") add("liquidity_preference", 0.8);
  if (features.liquidity_band === "medium") add("liquidity_preference", 0.2);
  if (features.volatility_band === "low") add("value_orientation", 0.4);
  if (features.volatility_band === "high") add("volatility_tolerance", 1);

  // Set-completion signal — repeated engagement with the same set_name boosts.
  // (Summed at a higher level — placeholder here to keep the structure consistent.)
  if (features.set_name) add("set_completion_bias", 0.1);

  // Mainstream / iconic pokemon in medium-high liquidity — mainstream signal.
  if (features.is_mainstream) add("liquidity_preference", 0.2);

  return deltas;
}

/**
 * Compute per-actor style scores from a list of behavior events.
 * The `resolveFeatures` callback lets callers provide card features lazily;
 * tests can pass a simple Map-backed resolver.
 */
export function scoreProfile(
  events: BehaviorEvent[],
  resolveFeatures: CardFeatureResolver,
  now: Date = new Date(),
): StyleScores {
  const raw = emptyScores();
  if (events.length === 0) return raw;

  const setFrequency = new Map<string, number>();

  for (const event of events) {
    const features = resolveFeatures(event.canonical_slug, event.variant_ref);
    const recency = recencyMultiplier(event.occurred_at, now);
    const deltas = dimensionDeltas(event, features);
    for (const dim of STYLE_DIMENSIONS) {
      const delta = deltas[dim];
      if (delta) raw[dim] += delta * recency;
    }
    if (features?.set_name) {
      const key = features.set_name;
      setFrequency.set(key, (setFrequency.get(key) ?? 0) + recency);
    }
  }

  // Set completion — if the same set is seen >3 times with material recency, boost.
  for (const [, count] of setFrequency) {
    if (count >= 3) raw.set_completion_bias += (count - 2) * 0.5;
  }

  return normalizeScores(raw);
}

// Soft normalization — each dimension is squashed via score / (score + k) so
// 0..1 range remains monotonic in raw signal. k is set so ~5 weighted events
// yield ~0.5.
const SOFTMAX_K = 5;

export function normalizeScores(raw: StyleScores): StyleScores {
  const out = emptyScores();
  for (const dim of STYLE_DIMENSIONS) {
    const value = raw[dim];
    if (!Number.isFinite(value) || value <= 0) {
      out[dim] = 0;
      continue;
    }
    out[dim] = value / (value + SOFTMAX_K);
    if (out[dim] < 0) out[dim] = 0;
    if (out[dim] > 1) out[dim] = 1;
  }
  return out;
}
