import "server-only";

import crypto from "node:crypto";
import { generateText } from "ai";

import { getPopAlphaModel } from "@/lib/ai/models";

// ── Constants ───────────────────────────────────────────────────────────────

export const CARD_PROFILE_VERSION = "card-profile-v2";
export const CARD_PROFILE_MODEL_TIER = "Ace" as const;
// Keep in sync with getPopAlphaModel("Ace"). Stored alongside every
// card_profiles row so historical data can be traced back to the
// model that produced it.
export const CARD_PROFILE_MODEL_LABEL = "gemini-2.5-flash";
// Upper bound per card. Prior value (6s) was too tight for
// gemini-2.5-flash in practice — first smoke test showed 2 of 3 cards
// timing out at ~6s. 15s gives ~3× headroom over the measured single-
// call latency while still bounding total cron wall time (500 cards ×
// 15s / concurrency=5 = ~25 min worst case vs. 300s maxDuration on
// Vercel, which is why we also have the deadline guard in the route).
export const CARD_PROFILE_TIMEOUT_MS = 15_000;

export const SIGNAL_LABELS = [
  "BREAKOUT",
  "COOLING",
  "VALUE_ZONE",
  "STEADY",
  "OVERHEATED",
] as const;
export type SignalLabel = (typeof SIGNAL_LABELS)[number];

export const VERDICTS = [
  "UNDERVALUED",
  "FAIR",
  "OVERHEATED",
  "INSUFFICIENT_DATA",
] as const;
export type Verdict = (typeof VERDICTS)[number];

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
  conditionPrices: Array<{ condition: string; price: number }> | null;
};

export type CardProfileResult = {
  signalLabel: SignalLabel;
  verdict: Verdict;
  chip: string;
  summaryShort: string;
  summaryLong: string;
  source: "llm" | "fallback";
  modelLabel: string;
  inputTokens: number | null;
  outputTokens: number | null;
  metricsHash: string;
  // When source === "fallback", carries the reason the LLM path failed
  // so the caller (cron route) can report it instead of silently
  // writing 100% fallbacks and returning ok:true. See
  // docs/project_silent_rpc_fallbacks.md — same lesson.
  //   - "llm-threw:<error>" — generateText threw synchronously (auth,
  //     model-not-found, rate-limit, abort, etc.)
  //   - "parse-miss"         — LLM returned text but parseLlmProfile
  //     rejected the shape
  //   - undefined            — source === "llm", no failure
  failureReason?: string;
};

// ── Metrics hash ────────────────────────────────────────────────────────────
//
// The hash is the refresh trigger for the card-profile cron — when it
// changes, the card's LLM summary gets regenerated. So sensitivity
// here directly controls how often we pay for an LLM call per card,
// and by extension steady-state cost.
//
// Coarsened 2026-04-26 to bound steady-state cost. Prior version
// rounded prices to the cent and changePct to 0.1% — sensitive enough
// that pure noise (cent-level price ticks, percent-point reporting
// precision, day-edge poll-window flicker on activeListings) was
// triggering LLM refreshes for cards whose narrative was unchanged.
//
// What's in the hash now:
//   marketPrice / median7d / low30d / high30d  → rounded to whole dollars
//   changePct7d                                 → rounded to whole percent
//
// What was DROPPED:
//   activeListings7d — turned out to be saturated at 100 for 99.84%
//   of cards (it's not really "active listings", it's a count of
//   provider snapshots in 7 days, capped via a *20-then-clamp formula).
//   Counts can flicker ±1 from rolling-window edge timing, which was
//   causing pure-noise refreshes. Still passed to the LLM in the
//   prompt for reasoning context — just not used as a refresh trigger.
//
// Combined with changePct rounded to integers, this still catches:
//   - $0.50 → $1.00      (100% move; changePct flips 0 → 100)
//   - $20  → $21         (5% move;  changePct flips 0 → 5)
//   - $200 → $210        (same 5% logic at any price level)
// While suppressing:
//   - $4.97 → $4.98      (penny tick, narrative unchanged)
//   - 4.4% → 4.5%        (sub-percent move, within reporting precision)
//   - listings 14 → 15   (poll-edge flicker, no real activity change)

function round0(v: number | null): string {
  return v != null && Number.isFinite(v) ? Math.round(v).toString() : "";
}

export function buildMetricsHash(input: CardProfileInput): string {
  const payload = [
    round0(input.marketPrice),
    round0(input.median7d),
    round0(input.changePct7d),
    round0(input.low30d),
    round0(input.high30d),
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ── Deterministic signal/verdict (used by fallback and as a sanity guard) ───

function pickSignal(input: CardProfileInput): SignalLabel {
  const change = input.changePct7d;
  const liquidity = input.liquidityScore;
  const volatility = input.volatility30d;

  if (typeof change === "number") {
    if (change >= 12) return "BREAKOUT";
    if (change <= -10) return "COOLING";
  }
  if (typeof volatility === "number" && volatility >= 35) return "OVERHEATED";

  // Value zone: priced in the lower half of the 30-day range with reasonable
  // liquidity — a soft "looks cheap, with depth" tag.
  if (
    typeof input.marketPrice === "number" &&
    typeof input.low30d === "number" &&
    typeof input.high30d === "number" &&
    input.high30d > input.low30d
  ) {
    const positionInRange =
      (input.marketPrice - input.low30d) / (input.high30d - input.low30d);
    if (positionInRange <= 0.35 && (liquidity ?? 0) >= 30) {
      return "VALUE_ZONE";
    }
  }

  return "STEADY";
}

function pickVerdict(input: CardProfileInput, signal: SignalLabel): Verdict {
  if (input.marketPrice == null) return "INSUFFICIENT_DATA";
  if (signal === "BREAKOUT" || signal === "OVERHEATED") return "OVERHEATED";
  if (signal === "VALUE_ZONE") return "UNDERVALUED";
  return "FAIR";
}

const SIGNAL_TO_CHIP: Record<SignalLabel, string> = {
  BREAKOUT: "🔥 Breakout",
  COOLING: "📉 Cooling Off",
  VALUE_ZONE: "💎 Value Zone",
  STEADY: "🔁 Holding Pattern",
  OVERHEATED: "⚠️ Running Hot",
};

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
  const signal = pickSignal(input);
  const verdict = pickVerdict(input, signal);

  let summaryShort: string;
  if (changeText) {
    summaryShort = changePct7d! > 0
      ? `${canonicalName} is trading around ${priceText}, up ${changeText} over the last 7 days.`
      : changePct7d! < 0
        ? `${canonicalName} is trading around ${priceText}, pulling back ${changeText} over the last 7 days.`
        : `${canonicalName} is holding steady around ${priceText}.`;
  } else {
    summaryShort = `${canonicalName} is trading around ${priceText}.`;
  }

  let supplyNote = "";
  if (activeListings7d != null) {
    supplyNote = activeListings7d <= 4
      ? ` Supply is limited with only ${activeListings7d} listings in the last 7 days.`
      : ` There have been ${activeListings7d} listings over the last 7 days.`;
  }

  const setContext = setName ? `, part of the ${setName} set` : "";
  const summaryLong = `${summaryShort}${supplyNote}${setContext}.`;

  return {
    signalLabel: signal,
    verdict,
    chip: SIGNAL_TO_CHIP[signal],
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
  "You are PopAlpha's market-signal analyst for Pokémon TCG collectors.",
  "Your job is to read a single card's market data and write an actionable, signal-led brief.",
  "",
  "Tone:",
  "- Plain English, 8th-grade reading level. Calm, sharp, useful.",
  "- Lead with the signal. Get straight to what's happening — never start with 'Okay', 'So', 'Currently', or any setup phrase.",
  "- Sound like a heads-up from a knowledgeable friend, not a market recap.",
  "- Avoid hype, slang, and finance jargon.",
  "- Never give buy / sell / hold advice. Reframe action as 'on watch', 'fading', 'cooling off', 'in a value zone', 'running hot'.",
  "- Do not mention being an AI. Do not invent metrics that aren't in the data.",
  "",
  "Signal labels (pick exactly one):",
  "- BREAKOUT  — strong upward move, price climbing meaningfully on the 7-day.",
  "- COOLING   — pulling back from recent highs.",
  "- VALUE_ZONE — sitting in the lower half of its 30-day range with real depth.",
  "- STEADY    — holding pattern, no decisive move.",
  "- OVERHEATED — volatile and stretched, bigger swings than the catalog norm.",
  "",
  "Verdicts (pick exactly one):",
  "- UNDERVALUED — price looks soft relative to the recent range.",
  "- FAIR        — price looks consistent with the recent range.",
  "- OVERHEATED  — price looks stretched relative to the recent range.",
  "- INSUFFICIENT_DATA — not enough signal to call.",
  "",
  "Output ONLY a single JSON object matching this exact shape:",
  '  {"signal_label":"...","verdict":"...","chip":"...","summary_short":"...","summary_long":"..."}',
  "",
  "Field rules:",
  "- signal_label: one of BREAKOUT, COOLING, VALUE_ZONE, STEADY, OVERHEATED.",
  "- verdict: one of UNDERVALUED, FAIR, OVERHEATED, INSUFFICIENT_DATA.",
  "- chip: 2–4 word phrase the user sees as a badge. Lead with a single emoji that matches the signal.",
  "    BREAKOUT → 🔥, COOLING → 📉, VALUE_ZONE → 💎, STEADY → 🔁, OVERHEATED → ⚠️.",
  "    Examples: \"🔥 Breakout Alert\", \"📉 Cooling Off\", \"💎 Value Zone\", \"🔁 Holding Pattern\", \"⚠️ Running Hot\".",
  "- summary_short: 1–2 sentences, 18–32 words. State the signal and what it means right now.",
  "    Lead with the move, not the price level. The user already sees the price.",
  "- summary_long: 3–4 sentences, 35–65 words. Add context: where the card sits in its recent range,",
  "    whether supply is thin or deep, and whether the move looks confirmed or fragile.",
  "    If condition spreads are meaningful, mention them in plain words.",
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

  if (input.conditionPrices && input.conditionPrices.length > 0) {
    lines.push("");
    lines.push("Condition pricing:");
    const conditionLabels: Record<string, string> = {
      nm: "Near Mint", lp: "Lightly Played", mp: "Moderately Played",
      hp: "Heavily Played", dmg: "Damaged",
    };
    for (const cp of input.conditionPrices) {
      const label = conditionLabels[cp.condition] ?? cp.condition.toUpperCase();
      lines.push(`  ${label}: $${cp.price.toFixed(2)}`);
    }
  }

  // Anchor the LLM with a deterministic suggested signal so it doesn't
  // freelance into BREAKOUT on a flat card. Phrased as a hint, not a
  // command — the model can override when the broader picture warrants it.
  const suggested = pickSignal(input);
  lines.push("");
  lines.push(`Suggested signal from raw metrics: ${suggested}`);

  return lines.join("\n");
}

// ── JSON parsing ────────────────────────────────────────────────────────────

type ParsedProfile = {
  signal_label: SignalLabel;
  verdict: Verdict;
  chip: string;
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

function isSignalLabel(v: unknown): v is SignalLabel {
  return typeof v === "string" && (SIGNAL_LABELS as readonly string[]).includes(v);
}

function isVerdict(v: unknown): v is Verdict {
  return typeof v === "string" && (VERDICTS as readonly string[]).includes(v);
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
  const chip = typeof obj.chip === "string" ? obj.chip.trim() : "";
  const signalLabel = obj.signal_label;
  const verdict = obj.verdict;

  if (!summaryShort || !summaryLong || !chip) return null;
  if (!isSignalLabel(signalLabel) || !isVerdict(verdict)) return null;
  if (summaryShort.length > 500 || summaryLong.length > 1000) return null;
  if (summaryShort.length < 15) return null;
  if (chip.length > 60) return null;

  return {
    signal_label: signalLabel,
    verdict,
    chip,
    summary_short: summaryShort,
    summary_long: summaryLong,
  };
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
      experimental_telemetry: {
        isEnabled: true,
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
      return { ...buildFallbackProfile(input), failureReason: "parse-miss" };
    }

    const usage = result.totalUsage ?? { inputTokens: undefined, outputTokens: undefined };
    return {
      signalLabel: parsed.signal_label,
      verdict: parsed.verdict,
      chip: parsed.chip,
      summaryShort: parsed.summary_short,
      summaryLong: parsed.summary_long,
      source: "llm",
      modelLabel: CARD_PROFILE_MODEL_LABEL,
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
      ...buildFallbackProfile(input),
      failureReason: `llm-threw:${errName}:${errMsg.slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
