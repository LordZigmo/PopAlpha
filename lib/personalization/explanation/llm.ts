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

// Bumped from 6_000 to 15_000 alongside the gemini-2.0-flash → 2.5-flash
// migration (commits ed9219a + 564ce8c). Same lesson as card-profile:
// 2.5-flash p95 sits in the 5-10s range and a 6s budget silently aborts
// a meaningful tail of calls. 15s gives headroom while staying inside
// any reasonable end-user wait expectation; the response is cached, so
// only the first request per (actor, card, metricsHash) tuple pays this.
const LLM_TIMEOUT_MS = 15_000;
const LLM_MODEL_TIER = "Ace" as const;
// Model-agnostic label so this constant doesn't drift the next time
// getPopAlphaModel("Ace") moves to a new generation. The actual model
// name is owned by lib/ai/models.ts; the label here is just for cache-
// row provenance.
const SOURCE_VERSION = `llm-v${PROFILE_VERSION}`;

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
  // Number of fresh price observations from the data provider over 7 days
  // (capped at 100). NOT a count of marketplace listings. See note in
  // lib/ai/card-profile-summary.ts CardProfileInput.
  priceObservations7d: number | null;
};

const SYSTEM_PROMPT = [
  "You are PopAlpha's personal card guide for Pokémon TCG collectors.",
  "You get (1) the collector's style profile, (2) features of a single card, and (3) the card's market signal.",
  "",
  "Your job: write a short read that ties together how the card is moving AND whether it fits this collector's style.",
  "The combined read is the point. A move that does not fit their style is a heads-up to skip. A quiet card that does fit is worth watching. A move that fits is a real heads-up.",
  "",
  // Voice + rules trimmed deliberately. Larger prompts pushed Gemini past
  // first-token latency budgets and drove AbortError rates up. Additions
  // here pay a per-card cost on every personalized read.
  "Voice:",
  "- 8th-grade reading level. Short sentences. Plain English. Everyday words.",
  "- Smart friend who knows their taste, not Wall Street analyst. No jargon, hype, or slang.",
  "- Speak in second person ('you usually go for…').",
  "- Be honest when the card does not fit. Say so plainly.",
  "- If confidence is low, say so. Don't pretend.",
  "- Never say buy / sell / hold. Use 'worth watching', 'cooling off', 'good buying range', 'running hot'.",
  "- Don't mention being an AI.",
  "",
  "Price tracking field:",
  "- 'Price tracking (7d)': thin (sparse data), steady (reliable), dense (very well-tracked).",
  "- This is NOT marketplace listings, supply, or copies for sale.",
  "- NEVER cite the raw 'Price observations' count. Never write 'X listings' or 'supply is thin'.",
  "",
  "Pattern: what's happening with the card → why it matters for THIS collector (style fit) → what to watch next.",
  "",
  "Weave market + style:",
  "- BREAKOUT + match → 'moving, and it's your kind of card'.",
  "- BREAKOUT + no match → 'moving, but not your usual pick'.",
  "- VALUE_ZONE + match → 'good buying range that fits your taste'.",
  "- COOLING / OVERHEATED + match → flag as heads-up, not entry.",
  "- STEADY → patient; say whether that fits.",
  "- No market signal → focus on style; say data is thin.",
  "",
  "Output ONLY a JSON object matching:",
  '  {"headline":"...","summary":"...","why_it_matches":"...","reasons":["...","..."],"caveats":["..."]}',
  "",
  "Rules:",
  "- headline: 6–10 words tying move + style fit.",
  "    e.g. \"Moving fast, and it's your kind of card\", \"Quiet, but in a good buying range\".",
  "- summary: 2–3 sentences, 25–55 words. Use the pattern above.",
  "- why_it_matches: 1 sentence naming the style trait.",
  "- reasons: 2–4 short phrases, 8–18 words each. Mix market + style.",
  "- caveats: 0–2 short phrases. Use one when style or move signal is thin.",
  "- No prose, no code fences, no markdown outside the JSON.",
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
    if (market.priceObservations7d != null) {
      // The bucket is what the model should reference; the raw count is
      // for tie-breaking only. The "do NOT cite the raw count" rule lives
      // in SYSTEM_PROMPT, not restated per card, to keep prompts compact.
      const bucket = market.priceObservations7d <= 4
        ? "thin"
        : market.priceObservations7d < 30
          ? "steady"
          : "dense";
      lines.push(`Price tracking (7d): ${bucket}`);
      lines.push(`Price observations raw count (7d): ${market.priceObservations7d}`);
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
      // LLM responded but the output didn't match the JSON contract.
      // Distinct from a thrown error — it means the model is reachable
      // and the API key works, the prompt or output is the issue.
      const sample = String(result.text ?? "").slice(0, 120).replace(/\s+/g, " ");
      console.warn(
        `[personalization:llm] parse miss slug=${card.canonical_slug} sample="${sample}"`,
      );
      return {
        ...buildTemplateExplanation(card, features, profile),
        source: "fallback",
        failureReason: "parse-miss",
      };
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
  } catch (err) {
    // Surface the actual error before falling back. Previously this
    // catch was bare (`catch { return template }`), which made every
    // upstream failure — auth, model deprecation, rate limit, abort —
    // indistinguishable from a user being on the template tier by
    // design. See docs/external-api-failure-modes.md for the
    // generalized rule.
    const errName = err instanceof Error ? err.name : "UnknownError";
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[personalization:llm] generateText threw slug=${card.canonical_slug} ${errName}: ${errMsg}`,
    );
    return {
      ...buildTemplateExplanation(card, features, profile),
      source: "fallback",
      failureReason: `llm-threw:${errName}:${errMsg.slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
