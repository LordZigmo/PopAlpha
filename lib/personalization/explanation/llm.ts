import "server-only";

import { generateText } from "ai";

import { getPopAlphaModel } from "@/lib/ai/models";

import { PROFILE_VERSION } from "../constants";
import type {
  CardStyleFeatures,
  PersonalizedExplanation,
  StyleProfile,
} from "../types";
import { buildTemplateExplanation, type ExplanationCardInput } from "./template";

const LLM_TIMEOUT_MS = 6_000;
const LLM_MODEL_TIER = "Ace" as const;
const SOURCE_VERSION = `llm-gemini2-flash-v${PROFILE_VERSION}`;

const SYSTEM_PROMPT = [
  "You are PopAlpha's personalized card analyst for Pokémon TCG collectors.",
  "You are given (1) a collector's inferred style profile and (2) structured features of a single card.",
  "Explain how well the card fits the collector's style in an observational, grounded tone.",
  "Rules:",
  "- Speak to the user in second person ('your activity suggests…', 'you tend to favor…').",
  "- Be observational, not prescriptive. Never give buy, sell, hold, or investment advice.",
  "- Do not claim fake certainty. If signal is thin, say so.",
  "- When the card does NOT match, say that plainly but respectfully.",
  "- Do not mention being an AI.",
  "- Plain English, 8th-grade reading level, no hype or finance jargon.",
  "- Output ONLY a single JSON object matching this exact shape:",
  '  {"headline":"...","summary":"...","why_it_matches":"...","reasons":["...","..."],"caveats":["..."]}',
  "- headline: 6–10 words.",
  "- summary: 1–2 sentences, 20–40 words.",
  "- why_it_matches: 1 short sentence.",
  "- reasons: 2–4 short bullet phrases, 10–20 words each.",
  "- caveats: 0–2 short phrases (can be empty array).",
  "- No prose, no code fences, no markdown outside the JSON object.",
].join("\n");

function buildUserPrompt(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile,
): string {
  const lines: string[] = [];
  lines.push("## Collector style profile");
  lines.push(`Dominant style: ${profile.dominant_style_label}`);
  if (profile.supporting_traits.length > 0) {
    lines.push(`Supporting traits: ${profile.supporting_traits.join(", ")}`);
  }
  lines.push(`Confidence: ${profile.confidence.toFixed(2)}`);
  lines.push(`Event count: ${profile.event_count}`);
  lines.push("Top dimension scores (0..1):");
  for (const evidence of profile.evidence.slice(0, 5)) {
    lines.push(`  - ${evidence.label}: ${evidence.weight}`);
  }
  lines.push("");
  lines.push("## Card features");
  lines.push(`Card: ${card.canonical_name}`);
  if (card.set_name) lines.push(`Set: ${card.set_name}`);
  if (features.release_year != null) lines.push(`Released: ${features.release_year}`);
  lines.push(`Era: ${features.era}`);
  lines.push(`Graded variant: ${features.is_graded ? "yes" : "no"}`);
  lines.push(`Iconic character: ${features.is_iconic ? "yes" : "no"}`);
  lines.push(`Art-forward rarity: ${features.is_art_centric ? "yes" : "no"}`);
  lines.push(`Liquidity band: ${features.liquidity_band}`);
  lines.push(`Volatility band: ${features.volatility_band}`);
  return lines.join("\n");
}

type ParsedLlmExplanation = {
  headline: string;
  summary: string;
  why_it_matches: string;
  reasons: string[];
  caveats: string[];
};

function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseLlmOutput(raw: string): ParsedLlmExplanation | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const headline = typeof obj.headline === "string" ? obj.headline.trim() : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const why = typeof obj.why_it_matches === "string" ? obj.why_it_matches.trim() : "";
  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.filter((v) => typeof v === "string").map((v) => (v as string).trim()).filter((v) => v.length > 0)
    : [];
  const caveats = Array.isArray(obj.caveats)
    ? obj.caveats.filter((v) => typeof v === "string").map((v) => (v as string).trim()).filter((v) => v.length > 0)
    : [];
  if (!headline || !summary || !why) return null;
  if (reasons.length === 0) return null;
  if (headline.length > 120 || summary.length > 400 || why.length > 200) return null;
  return { headline, summary, why_it_matches: why, reasons, caveats };
}

/**
 * Generate a personalized explanation via Gemini.
 * Returns the template fallback on any error or timeout.
 */
export async function buildLlmExplanation(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile,
): Promise<PersonalizedExplanation> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: getPopAlphaModel(LLM_MODEL_TIER),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(card, features, profile),
      abortSignal: controller.signal,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "personalized-card-explanation",
        metadata: { dominant_style: profile.dominant_style_label },
      },
    });
    const parsed = parseLlmOutput(result.text ?? "");
    if (!parsed) {
      return buildTemplateExplanation(card, features, profile);
    }
    return {
      headline: parsed.headline,
      summary: parsed.summary,
      why_it_matches: parsed.why_it_matches,
      reasons: parsed.reasons,
      caveats: parsed.caveats,
      confidence: profile.confidence,
      fits: profile.confidence >= 0.4 ? "aligned" : "neutral",
      generated_at: new Date().toISOString(),
      source: "llm",
      source_version: SOURCE_VERSION,
    };
  } catch {
    return buildTemplateExplanation(card, features, profile);
  } finally {
    clearTimeout(timeoutId);
  }
}
