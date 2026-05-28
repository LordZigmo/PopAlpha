/**
 * Capability / feature-gate boundary.
 *
 * V1: feature availability is env-controlled; Pro entitlement is enforced by
 * the route handler before personalized explanations are generated.
 *
 * Single swap point for mode/debug wiring — `getPersonalizationCapability`
 * is called wherever the feature is rendered or served.
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
  void _actor;
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
