import "server-only";

import { generateObject } from "ai";
import { z } from "zod";

import { getPopAlphaModel } from "@/lib/ai/models";
import { getPopAlphaGatewayModelId, geminiThinkingConfigForModel } from "@/lib/ai/model-config";

import { PROFILE_VERSION } from "../constants";
import type {
  CardStyleFeatures,
  CollectorBestMove,
  CollectorFitLabel,
  CollectorInsight,
  CollectorSignals,
  StyleProfile,
} from "../types";
import { COLLECTOR_BEST_MOVES, COLLECTOR_FIT_LABELS } from "../types";
import { buildCollectorInsightTemplate } from "./collector-insight-template";
import type { ExplanationCardInput } from "./template";

// gemini-2.5/3-flash p95 sits in the 5–10s range; a tight budget silently
// aborts a meaningful tail of calls. 15s gives headroom while staying inside
// any reasonable end-user wait. The response is cached, so only the first
// request per (actor, card, metricsHash) tuple pays this.
const LLM_TIMEOUT_MS = 15_000;
// Structured tasks under a tight output budget truncate when the model spends
// budget on reasoning. This is a small fixed-schema task, so give the JSON
// ample room (mirrors the card-profile-summary headroom lesson).
const LLM_MAX_OUTPUT_TOKENS = 900;
const LLM_MAX_RETRIES = 2;
// Cache-row provenance label; actual model is owned by lib/ai/models.ts.
const SOURCE_VERSION = `collector-llm-v${PROFILE_VERSION}`;

/**
 * Market signal context, sourced from the per-card market summary
 * (`card_profiles`). When a row is missing this is null and the prompt
 * falls back to plain feature reasoning.
 *
 * NOTE: this is the CARD-centered Market Brief context. The Collector Insight
 * prompt is told NOT to re-explain it — it is provided only so the user-
 * centered read can reason about whether the *current entry* fits this user,
 * not to restate what the market is doing.
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

// ── Structured output schema ────────────────────────────────────────────────
//
// generateObject forces the model to return JSON matching this schema. On a
// schema violation the SDK throws (caught below) → honest fallback, never a
// fabricated read. This is the structured replacement for the old loose
// free-text parse.
const CollectorInsightSchema = z.object({
  fitLabel: z
    .enum(COLLECTOR_FIT_LABELS as unknown as [CollectorFitLabel, ...CollectorFitLabel[]])
    .describe("How strongly this card fits the user's collector type. Pick the single best label."),
  fitScore: z
    .number()
    .min(0)
    .max(100)
    .describe("0–100. How well this card fits THIS user's profile. Not a market score."),
  collectorType: z
    .string()
    .min(1)
    .max(80)
    .describe("The user's determined collector type, restated in plain collector language."),
  summary: z
    .string()
    .min(1)
    .max(360)
    .describe("Why this card fits or does not fit THIS user. Specific to their collector type. Not a market recap."),
  roleInCollection: z
    .string()
    .min(1)
    .max(200)
    .describe("The role this card would play in the user's collection (e.g. centerpiece, supporting piece, watchlist-only)."),
  tradeoff: z
    .string()
    .min(1)
    .max(280)
    .describe("The honest tradeoff. Always present, even for a strong fit. No hype-only."),
  bestMove: z
    .enum(COLLECTOR_BEST_MOVES as unknown as [CollectorBestMove, ...CollectorBestMove[]])
    .describe("The single best move for THIS user. Not financial advice — collector framing."),
  popAlphaRead: z
    .string()
    .min(1)
    .max(220)
    .describe("One memorable, slightly opinionated final read."),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe("How certain you are, given how much real user data informed this. Use 'low' when data is thin."),
  dataBasis: z
    .string()
    .min(1)
    .max(200)
    .describe("Brief note on what user data informed this read (saved cards, scans, sets, etc.)."),
});

const SYSTEM_PROMPT = [
  "You are PopAlpha's Collector Insight engine.",
  "You are NOT writing a general market brief — the Market Brief already explains what's happening with this card in the broader market.",
  "Your job: explain how this card fits THIS specific user's collector type and collection behavior.",
  "",
  "Given: card identity, set, variant/language, raw/graded context, current market signals, the user's collector type, and the user's collection / watchlist / scan behavior when available.",
  "Write a Collector Insight answering ONE question: 'Should this card matter to this user?'",
  "",
  "Return structured JSON: fitLabel, fitScore, collectorType, summary, roleInCollection, tradeoff, bestMove, popAlphaRead, confidence, dataBasis.",
  "",
  "Rules:",
  "- Be specific to the user's collector type. Reference their actual signals when given (saved/watchlist/scanned cards, favorite sets, graded-vs-raw, JP-vs-EN).",
  "- Do NOT repeat the market brief. The market signal is context for whether the current ENTRY fits this user, not something to re-explain.",
  "- No financial advice. Use collector framing ('watchlist card', 'centerpiece', 'long-term piece'), never 'invest' / 'guaranteed' / 'can't miss'.",
  "- Do not hype every card. If it's a weak fit, say so clearly. Not every card is a Core Match.",
  "- Always include an honest tradeoff, even when the fit is strong.",
  "- Plain collector language. Concise enough for mobile.",
  "- Mention the data basis briefly.",
  "",
  "If user data is limited, do NOT fake certainty: set confidence to 'low' and use softer framing —",
  "  e.g. 'Early read: based on your scans so far…' or 'PopAlpha doesn't have much collection history yet, but this card appears to fit…'.",
  "",
  "Tone: direct, premium, collector-native, specific, honest, useful, slightly opinionated. NOT hypey, NOT horoscope-like, NOT vague.",
  "AVOID phrases like: 'aligns with your collecting journey', 'a great addition to any collection', 'as a passionate collector', 'strong potential' (without a reason), 'undervalued gem' (unless real signals support it).",
  "GOOD patterns: 'For your profile, this card matters because…', 'This fits your collection as a centerpiece, not a quick flip.',",
  "  'The card fits your taste, but the current entry may not give you much room for error.', 'This is more of a watchlist card than a buy-right-now card.',",
  "  'Good card, but not core to the collection you appear to be building.', 'This fits your heart. The question is whether the current price fits your head.'",
].join("\n");

function languageLabel(pref: CollectorSignals["languagePreference"]): string {
  switch (pref) {
    case "jp":
      return "Japanese-language";
    case "en":
      return "English-language";
    case "mixed":
      return "both JP and EN";
    default:
      return "unknown";
  }
}

function gradedLabel(interest: CollectorSignals["gradedVsRawInterest"]): string {
  switch (interest) {
    case "graded":
      return "graded / slabs";
    case "raw":
      return "raw / ungraded";
    case "mixed":
      return "both graded and raw";
    default:
      return "unknown";
  }
}

function buildUserPrompt(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  signals: CollectorSignals,
  market: MarketSignalContext | null,
): string {
  const lines: string[] = [];

  lines.push("## This user (collector profile)");
  lines.push(`Collector type: ${signals.collectorType}`);
  if (signals.supportingTraits.length > 0) {
    lines.push(`Supporting traits: ${signals.supportingTraits.join(", ")}`);
  }
  lines.push(`Profile confidence (0..1): ${signals.profileConfidence.toFixed(2)}`);
  lines.push(`Total tracked actions: ${signals.eventCount}`);
  lines.push(`Data richness: ${signals.dataConfidence}`);
  lines.push(`Graded vs raw interest: ${gradedLabel(signals.gradedVsRawInterest)}`);
  lines.push(`Language preference: ${languageLabel(signals.languagePreference)}`);
  if (signals.savedCardNames.length > 0) {
    lines.push(`Saved cards: ${signals.savedCardNames.slice(0, 8).join("; ")}`);
  }
  if (signals.watchlistCardNames.length > 0) {
    lines.push(`Watchlist cards: ${signals.watchlistCardNames.slice(0, 8).join("; ")}`);
  }
  if (signals.scannedCardNames.length > 0) {
    lines.push(`Scanned cards: ${signals.scannedCardNames.slice(0, 8).join("; ")}`);
  }
  if (signals.repeatedlyViewedCardNames.length > 0) {
    lines.push(`Repeatedly viewed: ${signals.repeatedlyViewedCardNames.slice(0, 6).join("; ")}`);
  }
  if (signals.favoriteSets.length > 0) {
    lines.push(`Most-engaged sets: ${signals.favoriteSets.slice(0, 4).join("; ")}`);
  }
  if (
    signals.savedCardNames.length === 0
    && signals.watchlistCardNames.length === 0
    && signals.scannedCardNames.length === 0
  ) {
    lines.push("(No saved / watchlist / scanned cards on record yet — keep the read soft and set confidence low.)");
  }

  lines.push("");
  lines.push("## This card");
  lines.push(`Card: ${card.canonical_name}`);
  if (card.set_name) lines.push(`Set: ${card.set_name}`);
  if (features.release_year != null) lines.push(`Released: ${features.release_year}`);
  lines.push(`Era: ${features.era}`);
  lines.push(`Graded variant being viewed: ${features.is_graded ? "yes" : "no"}`);
  lines.push(`Iconic character: ${features.is_iconic ? "yes" : "no"}`);
  lines.push(`Art-forward rarity: ${features.is_art_centric ? "yes" : "no"}`);
  lines.push(`Liquidity band: ${features.liquidity_band}`);
  lines.push(`Volatility band: ${features.volatility_band}`);

  lines.push("");
  lines.push("## Market context (DO NOT re-explain — for entry-fit judgement only)");
  if (market) {
    if (market.signalLabel) lines.push(`Signal: ${market.signalLabel}`);
    if (market.verdict) lines.push(`Verdict: ${market.verdict}`);
    if (market.summaryShort) lines.push(`Market read (already shown to the user elsewhere): ${market.summaryShort}`);
    if (market.marketPrice != null) lines.push(`Market price: $${market.marketPrice.toFixed(2)}`);
    if (market.changePct7d != null) {
      lines.push(`7-day change: ${market.changePct7d > 0 ? "+" : ""}${market.changePct7d.toFixed(1)}%`);
    }
  } else {
    lines.push("No fresh market signal — reason from collector fit and card features only.");
  }

  return lines.join("\n");
}

/**
 * Generate a structured Collector Insight via the LLM (forced structured
 * output). On any error, timeout, or schema violation, returns the
 * deterministic template insight tagged source:"fallback" + failureReason —
 * never a fabricated read. See docs/external-api-failure-modes.md.
 */
export async function buildLlmCollectorInsight(
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile,
  signals: CollectorSignals,
  market: MarketSignalContext | null,
): Promise<CollectorInsight> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const result = await generateObject({
      model: getPopAlphaModel(),
      schema: CollectorInsightSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(card, features, signals, market),
      abortSignal: controller.signal,
      // Gemini 2.5/3 are thinking models. With reasoning on, the output budget
      // is spent on (discarded) thoughts, leaving the JSON answer empty or
      // truncated → schema-validation failure → silent template fallback.
      // Minimize thinking (family-correct control) and give the JSON room.
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      maxRetries: LLM_MAX_RETRIES,
      providerOptions: {
        google: {
          thinkingConfig: geminiThinkingConfigForModel(getPopAlphaGatewayModelId()),
        },
      },
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: false,
        recordOutputs: false,
        functionId: "collector-insight",
        metadata: {
          collector_type: signals.collectorType,
          data_confidence: signals.dataConfidence,
          ...(market?.signalLabel ? { signal_label: market.signalLabel } : {}),
        },
      },
    });

    const obj = result.object;
    return {
      fitLabel: obj.fitLabel,
      fitScore: Math.max(0, Math.min(100, Math.round(obj.fitScore))),
      collectorType: obj.collectorType,
      summary: obj.summary,
      roleInCollection: obj.roleInCollection,
      tradeoff: obj.tradeoff,
      bestMove: obj.bestMove,
      popAlphaRead: obj.popAlphaRead,
      confidence: obj.confidence,
      dataBasis: obj.dataBasis,
      generated_at: new Date().toISOString(),
      source: "llm",
      source_version: SOURCE_VERSION,
    };
  } catch (err) {
    // Surface the actual error before falling back. A blind catch here would
    // make a 100% LLM outage (auth, deprecation, rate limit, abort, or a
    // schema-validation parse-miss) indistinguishable from a user being on the
    // template tier by design. See docs/external-api-failure-modes.md.
    const errName = err instanceof Error ? err.name : "UnknownError";
    const errMsg = err instanceof Error ? err.message : String(err);
    // generateObject throws a distinct error class on schema/parse failure
    // (NoObjectGeneratedError / TypeValidationError) vs. a transport throw.
    // Both still mean "no usable LLM output" → honest fallback.
    const isParseMiss =
      errName === "AI_NoObjectGeneratedError"
      || errName === "NoObjectGeneratedError"
      || errName === "AI_TypeValidationError"
      || errName === "TypeValidationError";
    console.error(
      `[personalization:collector-insight] generateObject ${isParseMiss ? "parse-miss" : "threw"} slug=${card.canonical_slug} ${errName}: ${errMsg}`,
    );
    return {
      ...buildCollectorInsightTemplate(card, features, profile, signals),
      source: "fallback",
      failureReason: isParseMiss ? "parse-miss" : `llm-threw:${errName}:${errMsg.slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
