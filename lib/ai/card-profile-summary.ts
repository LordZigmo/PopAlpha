import "server-only";

import { generateText } from "ai";

import {
  getPopAlphaCardProfileModel,
  getPopAlphaCardProfileModelId,
  getPopAlphaFeaturedCardProfileModel,
  getPopAlphaFeaturedCardProfileModelId,
} from "@/lib/ai/models";
import { geminiThinkingConfigForModel } from "@/lib/ai/model-config";
import {
  buildFallbackProfile,
  buildMetricsHash,
  CARD_PROFILE_MODEL_LABEL,
  priceTrackingBucket,
  SIGNAL_LABELS,
  VERDICTS,
  type CardProfileInput,
  type CardProfileResult,
  type SignalLabel,
  type Verdict,
} from "@/lib/ai/card-profile-fallback";

// Re-export the public surface from card-profile-fallback so existing
// callers (cron route, personalization explanation) don't need to
// retarget their imports. The split is mechanical: deterministic logic
// lives in card-profile-fallback (no server-only barrier, unit-testable);
// the LLM call itself stays here.
export {
  buildFallbackProfile,
  buildMetricsHash,
  CARD_PROFILE_MODEL_LABEL,
  priceTrackingBucket,
  SIGNAL_LABELS,
  VERDICTS,
  type CardProfileInput,
  type CardProfileResult,
  type SignalLabel,
  type Verdict,
};

// ── Constants used only by the LLM-call path ────────────────────────────────

export const CARD_PROFILE_VERSION = "card-profile-v2";
// Upper bound per card. Prior value (6s) was too tight for
// gemini-2.5-flash in practice — first smoke test showed 2 of 3 cards
// timing out at ~6s. 15s gives ~3× headroom over the measured single-
// call latency while still bounding total cron wall time (500 cards ×
// 15s / concurrency=5 = ~25 min worst case vs. 300s maxDuration on
// Vercel, which is why we also have the deadline guard in the route).
export const CARD_PROFILE_TIMEOUT_MS = 15_000;
// The hourly profile cron can process hundreds of cards. AI SDK defaults to
// two retries, which turns a provider-wide outage/quota issue into 3x API
// attempts and 3x telemetry spans for every card in the batch.
export const CARD_PROFILE_MAX_RETRIES = 0;

// ── Prompt ───────────────────────────────────────────────────────────────────

// Keep this tiny: the card-profile cron can call it hundreds of times.
// Deterministic code now picks signal/verdict/chip, so the model only
// spends tokens on the two user-facing sentences/paragraph.
const SYSTEM_PROMPT = [
  "You write PopAlpha card notes for Pokemon TCG collectors.",
  "Use only the supplied facts. Do not invent prices, listings, supply, or advice.",
  "Plain English, short sentences, smart friend tone. No jargon, hype, or slang.",
  "Do not say buy, sell, hold, investment, or being an AI.",
  'Return only JSON: {"summary_short":"...","summary_long":"..."}.',
  "summary_short: 2 sentences, 18-32 words. Lead with the market move.",
  "summary_long: 3 sentences, 30-55 words. Move, why it matters, what to watch.",
  "- No prose, no code fences, no markdown outside the JSON.",
].join("\n");

function formatUsd(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function formatSignedPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatConditionPrices(
  conditionPrices: CardProfileInput["conditionPrices"],
): string | null {
  if (!conditionPrices || conditionPrices.length === 0) return null;
  const rank: Record<string, number> = { nm: 0, lp: 1, mp: 2, hp: 3, dmg: 4 };
  const labels: Record<string, string> = {
    nm: "NM",
    lp: "LP",
    mp: "MP",
    hp: "HP",
    dmg: "DMG",
  };
  const parts = [...conditionPrices]
    .filter((cp) => Number.isFinite(cp.price))
    .sort((left, right) => (rank[left.condition] ?? 99) - (rank[right.condition] ?? 99))
    .slice(0, 4)
    .map((cp) => `${labels[cp.condition] ?? cp.condition.toUpperCase()} ${formatUsd(cp.price)}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function buildUserPrompt(
  input: CardProfileInput,
  baseline: Pick<CardProfileResult, "signalLabel" | "verdict">,
): string {
  const lines: string[] = [];
  lines.push(
    `Card: ${input.canonicalName}${input.setName ? ` (${input.setName})` : ""}${input.cardNumber ? ` #${input.cardNumber}` : ""}`,
  );
  lines.push(`Fixed signal: ${baseline.signalLabel}; verdict: ${baseline.verdict}`);

  const priceFacts = [
    formatUsd(input.marketPrice) ? `Market Price ${formatUsd(input.marketPrice)}` : null,
    formatUsd(input.recentMarketSignalUsd ?? null) && (input.recentMarketSignalDirection === "HIGHER" || input.recentMarketSignalDirection === "LOWER")
      ? `recent market signal ${input.recentMarketSignalDirection === "HIGHER" ? "higher" : "lower"} near ${formatUsd(input.recentMarketSignalUsd ?? null)}`
      : null,
    formatUsd(input.median7d) ? `7d median ${formatUsd(input.median7d)}` : null,
    formatUsd(input.median30d) ? `30d median ${formatUsd(input.median30d)}` : null,
    formatSignedPct(input.changePct7d) ? `7d move ${formatSignedPct(input.changePct7d)}` : null,
  ].filter(Boolean);
  if (priceFacts.length > 0) lines.push(`Price facts: ${priceFacts.join("; ")}`);
  if (input.low30d != null && input.high30d != null) {
    lines.push(`30d range: ${formatUsd(input.low30d)} to ${formatUsd(input.high30d)}`);
  }
  if (input.priceObservations7d != null) {
    const bucket = priceTrackingBucket(input.priceObservations7d);
    if (bucket) lines.push(`Price tracking reliability: ${bucket}`);
  }
  if (input.volatility30d != null) lines.push(`Volatility (30d): ${input.volatility30d.toFixed(1)}`);
  if (input.liquidityScore != null) lines.push(`Liquidity score: ${input.liquidityScore.toFixed(0)}/100`);
  const conditionPrices = formatConditionPrices(input.conditionPrices);
  if (conditionPrices) lines.push(`Condition prices: ${conditionPrices}`);

  return lines.join("\n");
}

function getCardProfileModelForInput(input: CardProfileInput) {
  return input.isHighPriority
    ? getPopAlphaFeaturedCardProfileModel()
    : getPopAlphaCardProfileModel();
}

// The Gateway model id actually used for this card, so we can pick the matching
// thinking control (gemini-3 → thinkingLevel, gemini-2.5 → thinkingBudget).
function getCardProfileModelIdForInput(input: CardProfileInput): string {
  return input.isHighPriority
    ? getPopAlphaFeaturedCardProfileModelId()
    : getPopAlphaCardProfileModelId();
}

function getCardProfileModelLabelForInput(input: CardProfileInput): string {
  return input.isHighPriority
    ? getPopAlphaFeaturedCardProfileModelId()
    : CARD_PROFILE_MODEL_LABEL;
}

// ── JSON parsing ────────────────────────────────────────────────────────────

type ParsedProfile = {
  summary_short: string;
  summary_long: string;
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

function parseLlmProfile(raw: string): ParsedProfile | null {
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
  const summaryShort = typeof obj.summary_short === "string" ? obj.summary_short.trim() : "";
  const summaryLong = typeof obj.summary_long === "string" ? obj.summary_long.trim() : "";

  if (!summaryShort || !summaryLong) return null;
  if (summaryShort.length > 500 || summaryLong.length > 1000) return null;
  if (summaryShort.length < 15) return null;

  return {
    summary_short: summaryShort,
    summary_long: summaryLong,
  };
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function generateCardProfile(
  input: CardProfileInput,
): Promise<CardProfileResult> {
  const modelLabel = getCardProfileModelLabelForInput(input);
  const fallbackProfile = { ...buildFallbackProfile(input), modelLabel };
  const metricsHash = fallbackProfile.metricsHash;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CARD_PROFILE_TIMEOUT_MS);

  try {
    const result = await generateText({
      model: getCardProfileModelForInput(input),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input, fallbackProfile),
      abortSignal: abortController.signal,
      // Gemini 2.5/3 are thinking models. With reasoning on, the output
      // budget is spent on (discarded) thoughts, leaving the JSON answer
      // empty or truncated → ~100% "parse-miss" (every card silently fell
      // back to the template). This is a tiny structured task, so minimize
      // thinking (family-correct control) and give the JSON ample room.
      maxOutputTokens: 768,
      providerOptions: {
        google: {
          thinkingConfig: geminiThinkingConfigForModel(getCardProfileModelIdForInput(input)),
        },
      },
      maxRetries: CARD_PROFILE_MAX_RETRIES,
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: false,
        recordOutputs: false,
        functionId: "card-profile-summary",
        metadata: { canonical_slug: input.canonicalSlug },
      },
    });

    const parsed = parseLlmProfile(result.text ?? "");
    if (!parsed) {
      // Text came back but didn't match the JSON contract. Keep the
      // fallback but surface the reason so we don't confuse "LLM broken"
      // with "prompt returning junk".
      const sample = String(result.text ?? "").slice(0, 120).replace(/\s+/g, " ");
      console.warn(
        `[card-profile] parse miss slug=${input.canonicalSlug} sample="${sample}"`,
      );
      return { ...fallbackProfile, failureReason: "parse-miss" };
    }

    const usage = result.totalUsage ?? { inputTokens: undefined, outputTokens: undefined };
    return {
      ...fallbackProfile,
      summaryShort: parsed.summary_short,
      summaryLong: parsed.summary_long,
      source: "llm",
      modelLabel,
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
      outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
      metricsHash,
    };
  } catch (err) {
    // Surface the actual error before falling back. Previously this
    // catch was silent, which hid auth / model-name / rate-limit bugs
    // for arbitrarily long — a 100% fallback rate looked identical to
    // a healthy run in the cron response. The runtime behavior is
    // still degrade-gracefully (one bad card doesn't take out the
    // batch), but the reason now leaves fingerprints in both logs and
    // the return value.
    const errName = err instanceof Error ? err.name : "UnknownError";
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[card-profile] generateText threw slug=${input.canonicalSlug} ${errName}: ${errMsg}`,
    );
    return {
      ...fallbackProfile,
      failureReason: `llm-threw:${errName}:${errMsg.slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
