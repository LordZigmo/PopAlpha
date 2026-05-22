import type { GatewayModelId } from "ai";

export const DEFAULT_POPALPHA_AI_GATEWAY_MODEL =
  "google/gemini-2.5-flash" satisfies GatewayModelId;
export const DEFAULT_POPALPHA_AI_GATEWAY_EMBEDDING_MODEL =
  "google/gemini-embedding-001";

export function getPopAlphaGatewayModelId(): GatewayModelId {
  return (
    process.env.POPALPHA_AI_GATEWAY_MODEL?.trim() ||
    DEFAULT_POPALPHA_AI_GATEWAY_MODEL
  );
}

export function getPopAlphaGatewayEmbeddingModelId(): string {
  return (
    process.env.POPALPHA_AI_GATEWAY_EMBEDDING_MODEL?.trim() ||
    DEFAULT_POPALPHA_AI_GATEWAY_EMBEDDING_MODEL
  );
}
