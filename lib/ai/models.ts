import { google } from "@ai-sdk/google";

export type PopAlphaTier = "Trainer" | "Ace" | "Elite";

// Gemini model assignments per PopAlpha tier.
//
// Keep these on currently-supported Google models — they deprecate
// aggressively. As of 2026-04-24 Google retired gemini-2.0-flash and
// gemini-1.5-flash for new users ("This model ... is no longer
// available to new users"), which silently bricked every LLM path
// wired through this function. The card-profile cron was returning
// ok:true with 100% fallbacks because the blanket catch in
// generateCardProfile was swallowing the deprecation error. See
// docs/project_silent_rpc_fallbacks.md for the generalized lesson.
//
// Successor mapping:
//   gemini-1.5-flash   → gemini-2.5-flash-lite  (same cheap/fast tier)
//   gemini-2.0-flash   → gemini-2.5-flash        (same balanced tier)
//
// When Google sunsets the 2.5 line, update in one place here. The
// MODEL_LABEL constants in call sites (card-profile-summary,
// homepage-brief) are cosmetic fingerprints stored alongside generated
// rows — bump them when the underlying model changes so stored rows
// accurately reflect which model produced them.
export function getPopAlphaModel(tier: PopAlphaTier) {
  switch (tier) {
    case "Trainer":
      return google("gemini-2.5-flash-lite");
    case "Ace":
    case "Elite":
      return google("gemini-2.5-flash");
    default:
      return google("gemini-2.5-flash-lite");
  }
}

export function getPopAlphaEmbeddingModel() {
  return google.textEmbeddingModel("gemini-embedding-001");
}
