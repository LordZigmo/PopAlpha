/**
 * Explanation dispatcher.
 *
 * Chooses between deterministic template and LLM mode based on capability.
 * Falls back gracefully to the template on any failure.
 */

import type { PersonalizationCapability } from "../capability";
import type {
  CardStyleFeatures,
  PersonalizedExplanation,
  StyleProfile,
} from "../types";
import type { ExplanationCardInput } from "./template";
import { buildTemplateExplanation } from "./template";
import type { MarketSignalContext } from "./llm";

export { buildTemplateExplanation };
export type { ExplanationCardInput };
export type { MarketSignalContext } from "./llm";

export async function buildPersonalizedExplanation(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
  capability: PersonalizationCapability,
  market: MarketSignalContext | null,
): Promise<PersonalizedExplanation> {
  // Template path — default. No network calls. Always safe.
  if (capability.mode === "template" || !profile) {
    return buildTemplateExplanation(card, features, profile);
  }

  // LLM path — only reached when explicitly enabled via env. Lazy-load to keep
  // client bundles clean; this file is consumed only from server contexts but
  // the dynamic import guards against accidental inclusion.
  //
  // Defense-in-depth catch: buildLlmExplanation itself never throws now
  // (it catches internally and returns a PersonalizedExplanation tagged
  // source:"fallback" + failureReason). The remaining failure surface
  // here is the dynamic import itself or some unexpected bug. Either
  // way, propagate a fingerprint instead of swallowing.
  try {
    const { buildLlmExplanation } = await import("./llm");
    return await buildLlmExplanation(card, features, profile, market);
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[personalization:explanation] llm path failed slug=${card.canonical_slug} ${errName}: ${errMsg}`,
    );
    return {
      ...buildTemplateExplanation(card, features, profile),
      source: "fallback",
      failureReason: `llm-import-or-unexpected:${errName}:${errMsg.slice(0, 160)}`,
    };
  }
}
