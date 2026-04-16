/**
 * Deterministic, template-based personalized explanation generator.
 *
 * No LLM, no network. Default path for dev and the only path used by unit
 * tests. Tone is observational and concise — never prescriptive.
 */

import { MIN_EVENTS_FOR_EARLY_SIGNAL, PROFILE_VERSION } from "../constants";
import type {
  CardStyleFeatures,
  PersonalizedExplanation,
  StyleDimension,
  StyleProfile,
} from "../types";

export type ExplanationCardInput = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
};

type Alignment = {
  fits: "aligned" | "neutral" | "contrast";
  aligned_dimensions: StyleDimension[];
  misaligned_dimensions: StyleDimension[];
};

/** Determine per-card alignment against a style profile. */
export function computeAlignment(
  features: CardStyleFeatures,
  profile: StyleProfile | null,
): Alignment {
  if (!profile || profile.event_count < MIN_EVENTS_FOR_EARLY_SIGNAL) {
    return { fits: "neutral", aligned_dimensions: [], misaligned_dimensions: [] };
  }

  const aligned: StyleDimension[] = [];
  const misaligned: StyleDimension[] = [];
  const s = profile.scores;

  function check(condition: boolean, high: StyleDimension, low?: StyleDimension) {
    if (condition && s[high] >= 0.25) aligned.push(high);
    else if (low && !condition && s[low] >= 0.25) aligned.push(low);
    else if (condition && low && s[low] >= 0.25) misaligned.push(low);
    else if (!condition && s[high] >= 0.25) misaligned.push(high);
  }

  check(features.era === "vintage", "vintage_affinity", "modern_affinity");
  check(features.era === "modern" || features.era === "contemporary", "modern_affinity", "vintage_affinity");
  check(features.is_iconic, "iconic_character_bias");
  check(features.is_art_centric, "art_affinity");
  check(features.is_graded, "graded_preference", "raw_preference");
  check(features.liquidity_band === "high", "liquidity_preference");
  check(features.volatility_band === "high", "volatility_tolerance");

  const score = aligned.length - misaligned.length;
  let fits: Alignment["fits"];
  if (score >= 1) fits = "aligned";
  else if (score <= -1) fits = "contrast";
  else fits = "neutral";

  return { fits, aligned_dimensions: aligned, misaligned_dimensions: misaligned };
}

function dimensionReason(dim: StyleDimension, features: CardStyleFeatures): string {
  switch (dim) {
    case "vintage_affinity":
      return features.era === "vintage"
        ? `It's a vintage-era card, which fits your typical browsing pattern.`
        : `You lean vintage, while this one is from a more recent era.`;
    case "modern_affinity":
      return features.era === "vintage"
        ? `You lean modern, while this one is older than most cards you engage with.`
        : `It's from a modern/contemporary set, matching what you usually look at.`;
    case "nostalgia_affinity":
      return `It has nostalgia signal — a common thread in your recent activity.`;
    case "art_affinity":
      return features.is_art_centric
        ? `It's an art-forward card (alt/illustration rare), aligned with your art-first habits.`
        : `You tend to favor art-forward cards; this one isn't particularly art-centric.`;
    case "liquidity_preference":
      return features.liquidity_band === "high"
        ? `Its market is relatively liquid, which lines up with how you usually browse.`
        : features.liquidity_band === "low"
          ? `You tend to engage with more liquid cards; this one is thinner on supply.`
          : `The market's liquidity is in a middle band.`;
    case "value_orientation":
      return `You tend to approach cards with a value lens — this one fits that frame.`;
    case "momentum_orientation":
      return `You tend to track momentum; this card's action is worth watching.`;
    case "raw_preference":
      return features.is_graded
        ? `You tend to focus on raw pricing; this is a graded variant.`
        : `It's priced in the raw-ungraded context you usually look at.`;
    case "graded_preference":
      return features.is_graded
        ? `It's a graded variant, aligned with how you usually compare cards.`
        : `You tend to focus on graded pricing; this is priced raw.`;
    case "iconic_character_bias":
      return features.is_iconic
        ? `It's an iconic-character card, which matches your typical picks.`
        : `You tend to gravitate toward iconic characters; this one is less canonical.`;
    case "set_completion_bias":
      return features.set_name
        ? `It's part of ${features.set_name}, a set you've been spending time in.`
        : `You tend to focus on completing sets.`;
    case "volatility_tolerance":
      return features.volatility_band === "high"
        ? `Its recent action has been volatile — consistent with cards you engage with.`
        : `You tolerate volatility; this one is relatively calm.`;
  }
}

function earlySignalFallback(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
): PersonalizedExplanation {
  const reasons: string[] = [];
  if (features.era === "vintage") reasons.push(`Vintage-era card from ${features.set_name ?? "an older set"}.`);
  if (features.is_iconic) reasons.push("Iconic-character card.");
  if (features.is_art_centric) reasons.push("Art-forward rarity (alt/illustration).");
  if (features.liquidity_band === "high") reasons.push("Active, liquid market.");
  if (reasons.length === 0) reasons.push("We don't have a strong signal on this card yet.");

  return {
    headline: `We're still learning your style`,
    summary: `${card.canonical_name} stands out for the reasons below. Browse a few more cards and we'll start to personalize this.`,
    why_it_matches: `Not enough activity yet to tell whether this card fits your typical pattern.`,
    reasons,
    caveats: ["Based on generic card attributes — no personal signal applied yet."],
    confidence: 0,
    fits: "neutral",
    generated_at: new Date().toISOString(),
    source: "fallback",
    source_version: `template-v${PROFILE_VERSION}`,
  };
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function buildTemplateExplanation(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
): PersonalizedExplanation {
  if (!profile || profile.event_count < MIN_EVENTS_FOR_EARLY_SIGNAL) {
    return earlySignalFallback(card, features);
  }

  const alignment = computeAlignment(features, profile);
  const styleLabel = profile.dominant_style_label;

  const reasons: string[] = [];
  for (const dim of alignment.aligned_dimensions.slice(0, 3)) {
    reasons.push(dimensionReason(dim, features));
  }
  if (alignment.fits === "contrast") {
    for (const dim of alignment.misaligned_dimensions.slice(0, 2)) {
      reasons.push(dimensionReason(dim, features));
    }
  }
  if (reasons.length === 0) {
    reasons.push(`Neither strongly aligned nor strongly opposed to your current pattern.`);
  }

  let headline: string;
  let summary: string;
  let whyItMatches: string;

  if (alignment.fits === "aligned") {
    headline = `Fits your ${styleLabel} lean`;
    summary = `${card.canonical_name} lines up with how you tend to browse — your activity suggests a ${styleLabel} pattern.`;
    whyItMatches = `This one matches your ${styleLabel} pattern in a few ways.`;
  } else if (alignment.fits === "contrast") {
    headline = `A bit outside your ${styleLabel} lean`;
    summary = `${card.canonical_name} is a little outside the ${styleLabel} pattern your recent activity suggests — which doesn't mean it isn't interesting.`;
    whyItMatches = `This one sits outside your typical ${styleLabel} pattern.`;
  } else {
    headline = `Neutral fit for your ${styleLabel} style`;
    summary = `${card.canonical_name} sits close to the middle of your ${styleLabel} pattern — some signals match, some don't.`;
    whyItMatches = `Mixed alignment against your typical ${styleLabel} pattern.`;
  }

  const caveats: string[] = [];
  if (profile.confidence < 0.4) {
    caveats.push("Early signal — this may shift as we learn more about your browsing.");
  }
  if (features.liquidity_band === "low") {
    caveats.push("The market for this card is relatively thin.");
  }

  return {
    headline: capitalize(headline),
    summary,
    why_it_matches: whyItMatches,
    reasons,
    caveats,
    confidence: profile.confidence,
    fits: alignment.fits,
    generated_at: new Date().toISOString(),
    source: "template",
    source_version: `template-v${PROFILE_VERSION}`,
  };
}
