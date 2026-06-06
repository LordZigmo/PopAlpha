/**
 * Explanation dispatcher.
 *
 * Two parallel surfaces:
 *  - Collector Insight (USER-centered, structured) — the primary product. See
 *    `buildCollectorInsight`. This is what the route returns on `collectorInsight`.
 *  - Legacy PersonalizedExplanation (loose schema) — retained for the existing
 *    web component + unit tests on the `explanation` key. See
 *    `buildPersonalizedExplanation`.
 *
 * Both choose between deterministic template and LLM mode based on capability
 * and fall back gracefully (honestly) to the template on any failure.
 */

import type { PersonalizationCapability } from "../capability";
import type {
  CardStyleFeatures,
  CollectorInsight,
  CollectorSignals,
  PersonalizedExplanation,
  StyleProfile,
} from "../types";
import type { ExplanationCardInput } from "./template";
import { buildTemplateExplanation } from "./template";
import { buildCollectorInsightTemplate } from "./collector-insight-template";
import type { MarketSignalContext } from "./llm";

export { buildTemplateExplanation };
export { buildCollectorInsightTemplate };
export type { ExplanationCardInput };
export type { MarketSignalContext } from "./llm";

/**
 * Primary surface: build the structured Collector Insight for (user, card).
 *
 * Template path is the default and is always safe (no network). LLM path is
 * only reached when explicitly enabled via capability AND a profile exists.
 * buildLlmCollectorInsight never throws — it catches internally and returns a
 * CollectorInsight tagged source:"fallback" + failureReason. The remaining
 * failure surface here is the dynamic import itself; propagate a fingerprint
 * instead of swallowing it (silent-fallback playbook).
 */
export async function buildCollectorInsight(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
  signals: CollectorSignals,
  capability: PersonalizationCapability,
  market: MarketSignalContext | null,
): Promise<CollectorInsight> {
  if (capability.mode === "template" || !profile) {
    return buildCollectorInsightTemplate(card, features, profile, signals);
  }

  try {
    const { buildLlmCollectorInsight } = await import("./llm");
    return await buildLlmCollectorInsight(card, features, profile, signals, market);
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[personalization:collector-insight] llm path failed slug=${card.canonical_slug} ${errName}: ${errMsg}`,
    );
    return {
      ...buildCollectorInsightTemplate(card, features, profile, signals),
      source: "fallback",
      failureReason: `llm-import-or-unexpected:${errName}:${errMsg.slice(0, 160)}`,
    };
  }
}

/**
 * Legacy surface — retained for the web component + unit tests on the loose
 * `explanation` schema. New clients should consume `collectorInsight`.
 *
 * Always deterministic now (the old loose-schema LLM prompt has been replaced
 * by the structured Collector Insight). This keeps the legacy key honest and
 * network-free rather than maintaining two divergent LLM prompts.
 */
export async function buildPersonalizedExplanation(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
  _capability: PersonalizationCapability,
  _market: MarketSignalContext | null,
): Promise<PersonalizedExplanation> {
  void _capability;
  void _market;
  return buildTemplateExplanation(card, features, profile);
}
