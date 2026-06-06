/**
 * Deterministic Collector Insight builder.
 *
 * No LLM, no network. This is the default path for the template tier AND the
 * honest fallback for the LLM tier — when the model is unreachable or returns
 * unparseable output, we emit a structured CollectorInsight from this builder
 * rather than fabricating certainty (see docs/external-api-failure-modes.md).
 *
 * It answers the same USER-centered question as the LLM ("should this card
 * matter to THIS collector?") but with conservative, signal-grounded copy. It
 * deliberately avoids hype and never gives financial advice.
 */

import { PROFILE_VERSION } from "../constants";
import type {
  CardStyleFeatures,
  CollectorBestMove,
  CollectorFitLabel,
  CollectorInsight,
  CollectorSignals,
  StyleProfile,
} from "../types";
import { computeAlignment, type ExplanationCardInput } from "./template";

const TEMPLATE_SOURCE_VERSION = `collector-template-v${PROFILE_VERSION}`;

/** Map alignment + signal richness to a fixed fit label. */
function pickFitLabel(
  fits: "aligned" | "neutral" | "contrast",
  features: CardStyleFeatures,
  signals: CollectorSignals,
): CollectorFitLabel {
  if (fits === "contrast") {
    // A clear mismatch is an honest "weak fit". The deterministic builder is
    // intentionally conservative and does not emit a hard "Pass for Your
    // Profile" label — that stronger claim is reserved for the LLM path, which
    // sees the full signal set. void the signals param ref to keep it explicit.
    void signals;
    return "Weak Fit";
  }
  if (fits === "neutral") {
    return "Style Match";
  }
  // Aligned — refine the flavor by which dimension carries it.
  if (features.is_art_centric) return "Strong Match";
  if (features.is_iconic) return "Strong Match";
  if (signals.gradedVsRawInterest === "graded" && features.is_graded) return "Strong Match";
  return "Core Match";
}

/** Map alignment + confidence to a 0–100 fit score. */
function pickFitScore(
  fits: "aligned" | "neutral" | "contrast",
  signals: CollectorSignals,
): number {
  const base = fits === "aligned" ? 78 : fits === "neutral" ? 55 : 34;
  // Nudge by how much personal signal backs the read.
  const confidenceNudge =
    signals.dataConfidence === "high"
      ? 8
      : signals.dataConfidence === "medium"
        ? 4
        : signals.dataConfidence === "low"
          ? 0
          : -6;
  const score = base + confidenceNudge;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function pickConfidenceBand(signals: CollectorSignals): CollectorInsight["confidence"] {
  switch (signals.dataConfidence) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

function pickBestMove(
  fits: "aligned" | "neutral" | "contrast",
  features: CardStyleFeatures,
  signals: CollectorSignals,
): CollectorBestMove {
  if (fits === "contrast") return "Pass";
  if (fits === "neutral") return "Watch";
  // Aligned. Volatile entry → urge patience; graded interest on a raw card →
  // grade angle; otherwise keep it conservative ("Watch", never "Buy now").
  if (features.volatility_band === "high") return "Buy only below recent support";
  if (signals.gradedVsRawInterest === "graded" && !features.is_graded) return "Grade";
  if (features.is_art_centric || features.is_iconic) return "Keep as a long-term collection piece";
  return "Watch";
}

function describeCollectorType(signals: CollectorSignals): string {
  // Title-case the dominant label into a "<Trait> Collector" phrasing without
  // overclaiming when we have no signal.
  if (signals.dataConfidence === "none") return "Collector (profile still forming)";
  return signals.collectorType;
}

function buildDataBasis(signals: CollectorSignals): string {
  const parts: string[] = [];
  if (signals.savedCardNames.length > 0) parts.push(`${signals.savedCardNames.length} saved`);
  if (signals.watchlistCardNames.length > 0) parts.push(`${signals.watchlistCardNames.length} on your watchlist`);
  if (signals.scannedCardNames.length > 0) parts.push(`${signals.scannedCardNames.length} scanned`);
  if (signals.favoriteSets.length > 0) parts.push(`time in ${signals.favoriteSets.slice(0, 2).join(" and ")}`);
  if (parts.length === 0) {
    return signals.eventCount > 0
      ? `Early read from your first ${signals.eventCount} actions in PopAlpha.`
      : `PopAlpha doesn't have much collection history for you yet.`;
  }
  return `Based on ${parts.join(", ")}.`;
}

export function buildCollectorInsightTemplate(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
  signals: CollectorSignals,
): CollectorInsight {
  const alignment = computeAlignment(features, profile);
  const fits = alignment.fits;
  const collectorType = describeCollectorType(signals);
  const fitLabel = pickFitLabel(fits, features, signals);
  const fitScore = pickFitScore(fits, signals);
  const bestMove = pickBestMove(fits, features, signals);
  const confidence = pickConfidenceBand(signals);
  const dataBasis = buildDataBasis(signals);

  const soft = signals.dataConfidence === "none" || signals.dataConfidence === "low";
  const lede = soft
    ? signals.dataConfidence === "none"
      ? `PopAlpha doesn't have much collection history yet, but `
      : `Early read: based on your activity so far, `
    : `For your profile, `;

  let summary: string;
  let roleInCollection: string;
  let tradeoff: string;
  let popAlphaRead: string;

  if (fits === "aligned") {
    const hook = features.is_art_centric
      ? "its art-forward appeal lines up with the kind of cards you keep coming back to"
      : features.is_iconic
        ? "it leans on an iconic character, which matches your usual picks"
        : features.era === "vintage"
          ? "it sits in the vintage era you tend to favor"
          : `it lines up with your ${collectorType} pattern`;
    summary = `${lede}this card matters because ${hook}.`;
    roleInCollection = features.is_art_centric || features.is_iconic
      ? "More of a centerpiece than a quick flip."
      : "A solid fit for the collection you appear to be building.";
    tradeoff = features.volatility_band === "high"
      ? "The card fits your taste, but the current entry may not give you much room for error."
      : "Good fit on taste; the open question is whether the current price fits your head, not just your heart.";
    popAlphaRead = "This fits the collection you appear to be building — just don't overpay for the feeling.";
  } else if (fits === "contrast") {
    summary = `${lede}this card sits outside your ${collectorType} pattern — it can still be interesting, just not core to what you're building.`;
    roleInCollection = "More of a watchlist card than a buy-right-now card for your profile.";
    tradeoff = "Good card, but not central to the collection you appear to be building.";
    popAlphaRead = "Fine card — just not the one that moves your collection forward.";
  } else {
    summary = `${lede}this card is a middle-of-the-road fit — some signals match your taste, some don't.`;
    roleInCollection = "Could fit as a supporting piece rather than an anchor.";
    tradeoff = "Mixed fit, so let the price and your own taste break the tie.";
    popAlphaRead = "Neither a must-have nor a pass — watch it and see if it grows on you.";
  }

  return {
    fitLabel,
    fitScore,
    collectorType,
    summary,
    roleInCollection,
    tradeoff,
    bestMove,
    popAlphaRead,
    confidence,
    dataBasis,
    generated_at: new Date().toISOString(),
    source: "template",
    source_version: TEMPLATE_SOURCE_VERSION,
  };
}
