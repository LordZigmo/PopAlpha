import type { GatewayModelId } from "ai";

export const DEFAULT_POPALPHA_AI_GATEWAY_MODEL =
  "google/gemini-2.5-flash" satisfies GatewayModelId;
export const DEFAULT_POPALPHA_CARD_PROFILE_AI_GATEWAY_MODEL =
  "google/gemini-2.5-flash-lite" satisfies GatewayModelId;
export const DEFAULT_POPALPHA_FEATURED_CARD_PROFILE_AI_GATEWAY_MODEL =
  "google/gemini-3-flash" satisfies GatewayModelId;
export const DEFAULT_POPALPHA_HOMEPAGE_BRIEF_AI_GATEWAY_MODEL =
  "google/gemini-3-flash" satisfies GatewayModelId;
export const DEFAULT_POPALPHA_AI_GATEWAY_EMBEDDING_MODEL =
  "google/gemini-embedding-001";

function readGatewayModelEnv(name: string, fallback: GatewayModelId): GatewayModelId {
  return (process.env[name]?.trim() || fallback) as GatewayModelId;
}

export function getPopAlphaGatewayModelId(): GatewayModelId {
  return readGatewayModelEnv(
    "POPALPHA_AI_GATEWAY_MODEL",
    DEFAULT_POPALPHA_AI_GATEWAY_MODEL,
  );
}

export function getPopAlphaCardProfileModelId(): GatewayModelId {
  return readGatewayModelEnv(
    "POPALPHA_CARD_PROFILE_AI_GATEWAY_MODEL",
    DEFAULT_POPALPHA_CARD_PROFILE_AI_GATEWAY_MODEL,
  );
}

export function getPopAlphaFeaturedCardProfileModelId(): GatewayModelId {
  return readGatewayModelEnv(
    "POPALPHA_FEATURED_CARD_PROFILE_AI_GATEWAY_MODEL",
    DEFAULT_POPALPHA_FEATURED_CARD_PROFILE_AI_GATEWAY_MODEL,
  );
}

export function getPopAlphaHomepageBriefModelId(): GatewayModelId {
  return readGatewayModelEnv(
    "POPALPHA_HOMEPAGE_BRIEF_AI_GATEWAY_MODEL",
    DEFAULT_POPALPHA_HOMEPAGE_BRIEF_AI_GATEWAY_MODEL,
  );
}

export function getPopAlphaGatewayEmbeddingModelId(): string {
  return (
    process.env.POPALPHA_AI_GATEWAY_EMBEDDING_MODEL?.trim() ||
    DEFAULT_POPALPHA_AI_GATEWAY_EMBEDDING_MODEL
  );
}

export type GeminiThinkingConfig = {
  thinkingBudget?: number;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  includeThoughts?: boolean;
};

// Minimize Gemini "thinking" for our tiny structured-JSON tasks (card profile,
// homepage brief). With reasoning on, thought tokens consume the output budget
// and the JSON answer comes back empty/truncated → parse-miss → silent template
// fallback (observed in prod: every recent parse-miss was on gemini-3-flash).
// The control differs by family and the two are MUTUALLY EXCLUSIVE — sending
// both thinking_level and thinking_budget in one request is a 400
// (https://ai.google.dev/gemini-api/docs/gemini-3#thinking_level):
//   - Gemini 3.x: thinking_level "minimal" — documented as "matches no
//     thinking" and supported on gemini-3-flash. We first tried "low" and the
//     homepage brief recovered, but card-profile JSON still truncated under its
//     smaller output budget, i.e. "low" still spends enough reasoning tokens to
//     eat the answer. "minimal" removes that consumption entirely.
//   - Gemini 2.5: thinking_budget 0 disables thinking.
export function geminiThinkingConfigForModel(modelId: string): GeminiThinkingConfig {
  if (/gemini-3/i.test(modelId)) {
    return { thinkingLevel: "minimal", includeThoughts: false };
  }
  return { thinkingBudget: 0, includeThoughts: false };
}
