import { google } from "@ai-sdk/google";

// Single Gemini model for all PopAlpha LLM call sites.
//
// Keep this on a currently-supported Google model — they deprecate
// aggressively. As of 2026-04-24 Google retired gemini-2.0-flash and
// gemini-1.5-flash for new users ("This model ... is no longer
// available to new users"), which silently bricked every LLM path
// wired through this function. The card-profile cron was returning
// ok:true with 100% fallbacks because the blanket catch in
// generateCardProfile was swallowing the deprecation error. See
// docs/project_silent_rpc_fallbacks.md for the generalized lesson.
//
// When Google sunsets the 2.5 line, update in one place here. The
// MODEL_LABEL constants in call sites (card-profile-summary,
// homepage-brief) are cosmetic fingerprints stored alongside generated
// rows — bump them when the underlying model changes so stored rows
// accurately reflect which model produced them.
export function getPopAlphaModel() {
  return google("gemini-2.5-flash");
}

export function getPopAlphaEmbeddingModel() {
  return google.textEmbeddingModel("gemini-embedding-001");
}
