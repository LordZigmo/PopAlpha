import { gateway } from "ai";

import {
  getPopAlphaCardProfileModelId,
  getPopAlphaFeaturedCardProfileModelId,
  getPopAlphaGatewayEmbeddingModelId,
  getPopAlphaGatewayModelId,
  getPopAlphaHomepageBriefModelId,
} from "@/lib/ai/model-config";

export {
  DEFAULT_POPALPHA_CARD_PROFILE_AI_GATEWAY_MODEL,
  DEFAULT_POPALPHA_FEATURED_CARD_PROFILE_AI_GATEWAY_MODEL,
  DEFAULT_POPALPHA_AI_GATEWAY_EMBEDDING_MODEL,
  DEFAULT_POPALPHA_AI_GATEWAY_MODEL,
  DEFAULT_POPALPHA_HOMEPAGE_BRIEF_AI_GATEWAY_MODEL,
  getPopAlphaCardProfileModelId,
  getPopAlphaFeaturedCardProfileModelId,
  getPopAlphaGatewayEmbeddingModelId,
  getPopAlphaGatewayModelId,
  getPopAlphaHomepageBriefModelId,
} from "@/lib/ai/model-config";

// Vercel AI Gateway model helpers for PopAlpha LLM call sites.
//
// Gateway keeps provider auth, budgets, observability, and model
// switching in Vercel instead of scattering direct provider clients
// across the app. Locally, set AI_GATEWAY_API_KEY. Override model IDs with
// POPALPHA_AI_GATEWAY_MODEL / POPALPHA_CARD_PROFILE_AI_GATEWAY_MODEL /
// POPALPHA_FEATURED_CARD_PROFILE_AI_GATEWAY_MODEL /
// POPALPHA_HOMEPAGE_BRIEF_AI_GATEWAY_MODEL /
// POPALPHA_AI_GATEWAY_EMBEDDING_MODEL.
//
// When a model sunsets or we want to compare options, change the env var
// in one place and the stored model labels will follow the Gateway id.
export function getPopAlphaModel() {
  return gateway(getPopAlphaGatewayModelId());
}

export function getPopAlphaCardProfileModel() {
  return gateway(getPopAlphaCardProfileModelId());
}

export function getPopAlphaFeaturedCardProfileModel() {
  return gateway(getPopAlphaFeaturedCardProfileModelId());
}

export function getPopAlphaHomepageBriefModel() {
  return gateway(getPopAlphaHomepageBriefModelId());
}

export function getPopAlphaEmbeddingModel() {
  return gateway.embeddingModel(getPopAlphaGatewayEmbeddingModelId());
}
