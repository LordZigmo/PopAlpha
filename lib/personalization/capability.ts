/**
 * Capability / feature-gate boundary.
 *
 * V1: enabled by default. Real LLM path opt-in via env.
 *
 * Single swap point for future paywall wiring — `getPersonalizationCapability`
 * is called wherever the feature is rendered or served. To paywall later,
 * extend this function (e.g. check `hasPro(actor.clerk_user_id)`) without
 * touching any of the consumers.
 */

import type { Actor } from "./types";

export type ExplanationMode = "template" | "llm";

export type PersonalizationCapability = {
  enabled: boolean;
  mode: ExplanationMode;
  debugEnabled: boolean;
  reason?: string;
};

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function falsy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

export function getPersonalizationCapability(_actor: Actor): PersonalizationCapability {
  const personalizationDisabled = falsy(process.env.NEXT_PUBLIC_ENABLE_PERSONALIZATION);
  const llmEnabled = truthy(process.env.NEXT_PUBLIC_ENABLE_PERSONALIZATION_LLM);
  const debugEnabled =
    process.env.NODE_ENV !== "production"
    || truthy(process.env.NEXT_PUBLIC_ENABLE_PERSONALIZATION_DEBUG);

  if (personalizationDisabled) {
    return {
      enabled: false,
      mode: "template",
      debugEnabled,
      reason: "NEXT_PUBLIC_ENABLE_PERSONALIZATION=false",
    };
  }

  return {
    enabled: true,
    mode: llmEnabled ? "llm" : "template",
    debugEnabled,
  };
}
