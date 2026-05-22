import { gateway } from "ai";

import {
  getPopAlphaGatewayEmbeddingModelId,
  getPopAlphaGatewayModelId,
} from "@/lib/ai/model-config";

export {
  DEFAULT_POPALPHA_AI_GATEWAY_EMBEDDING_MODEL,
  DEFAULT_POPALPHA_AI_GATEWAY_MODEL,
  getPopAlphaGatewayEmbeddingModelId,
  getPopAlphaGatewayModelId,
} from "@/lib/ai/model-config";

// Single Vercel AI Gateway model for all PopAlpha LLM call sites.
//
// Gateway keeps provider auth, budgets, observability, and model
// switching in Vercel instead of scattering direct provider clients
// across the app. Locally, set AI_GATEWAY_API_KEY. Override model IDs
// with POPALPHA_AI_GATEWAY_MODEL / POPALPHA_AI_GATEWAY_EMBEDDING_MODEL.
//
// When a model sunsets or we want to compare options, change the env var
// in one place and the stored model labels will follow the Gateway id.
export function getPopAlphaModel() {
  return gateway(getPopAlphaGatewayModelId());
}

export function getPopAlphaEmbeddingModel() {
  return gateway.embeddingModel(getPopAlphaGatewayEmbeddingModelId());
}
