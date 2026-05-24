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
