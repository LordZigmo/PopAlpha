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

export { buildTemplateExplanation };
export type { ExplanationCardInput };

export async function buildPersonalizedExplanation(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
  capability: PersonalizationCapability,
): Promise<PersonalizedExplanation> {
  // Template path — default. No network calls. Always safe.
  if (capability.mode === "template" || !profile) {
    return buildTemplateExplanation(card, features, profile);
  }

  // LLM path — only reached when explicitly enabled via env. Lazy-load to keep
  // client bundles clean; this file is consumed only from server contexts but
  // the dynamic import guards against accidental inclusion.
  try {
    const { buildLlmExplanation } = await import("./llm");
    return await buildLlmExplanation(card, features, profile);
  } catch (err) {
    console.error("[personalization:explanation] llm path failed, falling back", err);
    return buildTemplateExplanation(card, features, profile);
  }
}
