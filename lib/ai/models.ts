import { google } from "@ai-sdk/google";

export type PopAlphaTier = "Trainer" | "Ace" | "Elite";

export function getPopAlphaModel(tier: PopAlphaTier) {
  switch (tier) {
    case "Trainer":
      return google("gemini-1.5-flash");
    case "Ace":
    case "Elite":
      return google("gemini-2.0-flash");
  }
}
