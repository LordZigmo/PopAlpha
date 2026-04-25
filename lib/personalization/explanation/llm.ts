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

/**
 * Market signal context, sourced from the per-card market summary
 * (`card_profiles`). When a row is missing this is null and the prompt
 * falls back to plain feature reasoning.
 */
export type MarketSignalContext = {
  signalLabel: string | null;     // BREAKOUT | COOLING | VALUE_ZONE | STEADY | OVERHEATED
  verdict: string | null;         // UNDERVALUED | FAIR | OVERHEATED | INSUFFICIENT_DATA
  chip: string | null;            // e.g. "🔥 Breakout Alert"
  summaryShort: string | null;    // 1–2 sentence market read
  marketPrice: number | null;
  changePct7d: number | null;
  activeListings7d: number | null;
};

const SYSTEM_PROMPT = [
  "You are PopAlpha's personalized card analyst for Pokémon TCG collectors.",
  "You are given (1) a collector's inferred style profile, (2) structured features of a single card,",
  "and (3) the card's current market signal.",
  "",
  "Your job: write a tight read that reasons across BOTH the market move AND how the card fits the user's style.",
  "The combined read is the value. A breakout that doesn't fit is a heads-up to skip; a slow burner that does fit is a quiet hold; a breakout that fits is a 'don't miss this' nudge.",
  "",
  "Tone:",
  "- Speak to the user in second person ('you tend to favor…', 'this isn't getting the price action you usually look for').",
  "- Plain English, 8th-grade reading level. Calm, useful, observational.",
  "- Be honest when the card doesn't fit. Say so plainly but respectfully.",
  "- Never give buy / sell / hold advice. Reframe action as 'on watch', 'fading', 'in a value zone', 'running hot'.",
  "- Do not claim fake certainty. If style signal is thin (low confidence, few events), say so.",
  "- Do not mention being an AI.",
  "- Avoid hype, slang, and finance jargon.",
  "",
  "How to weave market + style:",
  "- If the market signal is BREAKOUT and the card matches style → 'this is moving, and it's the kind of card you usually engage with'.",
  "- If BREAKOUT but style doesn't match → 'this is moving, but it's not the type of price action you usually look for'.",
  "- If VALUE_ZONE and style matches → 'sitting in your kind of pocket — quiet but in range'.",
  "- If COOLING/OVERHEATED and style matches → flag the move as a heads-up, not an entry.",
  "- If STEADY → describe the card as patient; speak to whether the user has the patience profile for it.",
  "- If no market signal is present, focus on the style fit and acknowledge market context is thin.",
  "",
  "Output ONLY a single JSON object matching this exact shape:",
  '  {"headline":"...","summary":"...","why_it_matches":"...","reasons":["...","..."],"caveats":["..."]}',
  "",
  "Field rules:",
  "- headline: 6–10 words. Pull together the market move and the style fit in one phrase.",
  "    Examples: \"Breakout that fits your fast-flip lean\", \"Slow burner — not your usual price action\", \"Quiet, but in your value zone\".",
  "- summary: 1–2 sentences, 25–45 words. Combine the move + the fit. Lead with the most useful framing.",
  "- why_it_matches: 1 short sentence that names the specific style trait this lines up with (or doesn't).",
  "- reasons: 2–4 short bullet phrases, 10–20 words each. Each reason should reference EITHER the market state OR a style dimension — ideally a mix.",
  "- caveats: 0–2 short phrases. Use one when style signal is thin or when the move is fragile.",
  "- No prose, no code fences, no markdown outside the JSON object.",
].join("\n");

function buildUserPrompt(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile,
  market: MarketSignalContext | null,
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

  lines.push("");
  lines.push("## Market signal");
  if (market) {
    if (market.signalLabel) lines.push(`Signal: ${market.signalLabel}`);
    if (market.verdict) lines.push(`Verdict: ${market.verdict}`);
    if (market.chip) lines.push(`Chip phrase: ${market.chip}`);
    if (market.summaryShort) lines.push(`Recent read: ${market.summaryShort}`);
    if (market.marketPrice != null) lines.push(`Price: $${market.marketPrice.toFixed(2)}`);
    if (market.changePct7d != null) {
      lines.push(`7-day change: ${market.changePct7d > 0 ? "+" : ""}${market.changePct7d.toFixed(1)}%`);
    }
    if (market.activeListings7d != null) {
      lines.push(`Active listings (7d): ${market.activeListings7d}`);
    }
  } else {
    lines.push("No fresh market signal available — reason from style + features only.");
  }

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
 *
 * The prompt reasons across both the user's style profile and the per-card
 * market signal (when available) so the read tells the user not just whether
 * the card fits their pattern, but whether the current move is the kind of
 * price action they usually engage with.
 */
export async function buildLlmExplanation(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile,
  market: MarketSignalContext | null,
): Promise<PersonalizedExplanation> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: getPopAlphaModel(LLM_MODEL_TIER),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(card, features, profile, market),
      abortSignal: controller.signal,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "personalized-card-explanation",
        metadata: {
          dominant_style: profile.dominant_style_label,
          ...(market?.signalLabel ? { signal_label: market.signalLabel } : {}),
        },
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
