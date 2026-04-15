import "server-only";

import crypto from "node:crypto";
import { generateText } from "ai";

import { getPopAlphaModel } from "@/lib/ai/models";

// ── Constants ───────────────────────────────────────────────────────────────

export const CARD_PROFILE_VERSION = "card-profile-v1";
export const CARD_PROFILE_MODEL_TIER = "Ace" as const;
export const CARD_PROFILE_MODEL_LABEL = "gemini-2.0-flash";
export const CARD_PROFILE_TIMEOUT_MS = 6_000;

// ── Types ───────────────────────────────────────────────────────────────────

export type CardProfileInput = {
  canonicalSlug: string;
  canonicalName: string;
  setName: string | null;
  cardNumber: string | null;
  marketPrice: number | null;
  median7d: number | null;
  median30d: number | null;
  changePct7d: number | null;
  low30d: number | null;
  high30d: number | null;
  activeListings7d: number | null;
  volatility30d: number | null;
  liquidityScore: number | null;
};

export type CardProfileResult = {
  summaryShort: string;
  summaryLong: string;
  source: "llm" | "fallback";
  modelLabel: string;
  inputTokens: number | null;
  outputTokens: number | null;
  metricsHash: string;
};

// ── Metrics hash ────────────────────────────────────────────────────────────

function round2(v: number | null): string {
  return v != null && Number.isFinite(v) ? v.toFixed(2) : "";
}

function round1(v: number | null): string {
  return v != null && Number.isFinite(v) ? v.toFixed(1) : "";
}

export function buildMetricsHash(input: CardProfileInput): string {
  const payload = [
    round2(input.marketPrice),
    round2(input.median7d),
    round1(input.changePct7d),
    round2(input.low30d),
    round2(input.high30d),
    String(input.activeListings7d ?? ""),
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ── Deterministic fallback ──────────────────────────────────────────────────

function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "an unpriced level";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatSignedPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
}

export function buildFallbackProfile(input: CardProfileInput): CardProfileResult {
  const { canonicalName, setName, marketPrice, changePct7d, activeListings7d } = input;
  const priceText = formatUsd(marketPrice);
  const changeText = formatSignedPct(changePct7d);

  let summaryShort: string;
  if (changeText) {
    summaryShort = changePct7d! > 0
      ? `${canonicalName} is trading around ${priceText}, up ${changeText} over the last 7 days.`
      : changePct7d! < 0
        ? `${canonicalName} is trading around ${priceText}, down ${changeText} over the last 7 days.`
        : `${canonicalName} is trading around ${priceText} and has been flat over the last 7 days.`;
  } else {
    summaryShort = `${canonicalName} is trading around ${priceText}.`;
  }

  let supplyNote = "";
  if (activeListings7d != null) {
    supplyNote = activeListings7d <= 4
      ? ` Supply looks tight with only ${activeListings7d} listings in the last 7 days.`
      : ` There were ${activeListings7d} listings over the last 7 days.`;
  }

  const setNote = setName ? ` from ${setName}` : "";
  const summaryLong = `${summaryShort}${supplyNote} This is ${canonicalName}${setNote}.`;

  return {
    summaryShort,
    summaryLong,
    source: "fallback",
    modelLabel: CARD_PROFILE_MODEL_LABEL,
    inputTokens: null,
    outputTokens: null,
    metricsHash: buildMetricsHash(input),
  };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You are PopAlpha's card analyst for Pokémon TCG collectors.",
  "Write a concise market summary for a single card based on the data provided.",
  "Rules:",
  "- Write in plain English at an 8th-grade reading level.",
  "- Sound calm, sharp, and useful. Avoid hype, slang, and finance jargon.",
  "- Do not repeat raw numbers verbatim; interpret them.",
  "- Do not mention being an AI.",
  "- Output ONLY a single JSON object matching this exact shape:",
  '  {"summary_short":"...","summary_long":"..."}',
  "- summary_short: exactly 2 sentences, 15–30 words. State the card's current price direction and whether it looks strong or weak.",
  "- summary_long: exactly 3–4 sentences, 30–60 words. Add context about supply, positioning within its price range, and whether the card looks fairly priced.",
  "- Do not output anything outside the JSON object. No prose, no code fences, no markdown.",
].join("\n");

function buildUserPrompt(input: CardProfileInput): string {
  const lines: string[] = [];
  lines.push(`Card: ${input.canonicalName}`);
  if (input.setName) lines.push(`Set: ${input.setName}`);
  if (input.cardNumber) lines.push(`Number: ${input.cardNumber}`);

  if (input.marketPrice != null) lines.push(`Market price: $${input.marketPrice.toFixed(2)}`);
  if (input.median7d != null) lines.push(`7-day median: $${input.median7d.toFixed(2)}`);
  if (input.median30d != null) lines.push(`30-day median: $${input.median30d.toFixed(2)}`);
  if (input.changePct7d != null) {
    lines.push(`7-day change: ${input.changePct7d > 0 ? "+" : ""}${input.changePct7d.toFixed(1)}%`);
  }
  if (input.low30d != null && input.high30d != null) {
    lines.push(`30-day range: $${input.low30d.toFixed(2)} – $${input.high30d.toFixed(2)}`);
  }
  if (input.activeListings7d != null) lines.push(`Active listings (7d): ${input.activeListings7d}`);
  if (input.volatility30d != null) lines.push(`Volatility (30d): ${input.volatility30d.toFixed(1)}`);
  if (input.liquidityScore != null) lines.push(`Liquidity score: ${input.liquidityScore.toFixed(0)}/100`);

  return lines.join("\n");
}

// ── JSON parsing ────────────────────────────────────────────────────────────

type ParsedProfile = { summary_short: string; summary_long: string };

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
  return { summary_short: summaryShort, summary_long: summaryLong };
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function generateCardProfile(
  input: CardProfileInput,
): Promise<CardProfileResult> {
  const metricsHash = buildMetricsHash(input);
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CARD_PROFILE_TIMEOUT_MS);

  try {
    const result = await generateText({
      model: getPopAlphaModel(CARD_PROFILE_MODEL_TIER),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      abortSignal: abortController.signal,
    });

    const parsed = parseLlmProfile(result.text ?? "");
    if (!parsed) {
      return buildFallbackProfile(input);
    }

    const usage = result.totalUsage ?? { inputTokens: undefined, outputTokens: undefined };
    return {
      summaryShort: parsed.summary_short,
      summaryLong: parsed.summary_long,
      source: "llm",
      modelLabel: CARD_PROFILE_MODEL_LABEL,
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
      outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
      metricsHash,
    };
  } catch {
    return buildFallbackProfile(input);
  } finally {
    clearTimeout(timeoutId);
  }
}
