import "server-only";

import { generateText } from "ai";

import { getPopAlphaModel } from "@/lib/ai/models";
import {
  buildFallbackProfile,
  buildMetricsHash,
  CARD_PROFILE_MODEL_LABEL,
  pickSignal,
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
export const CARD_PROFILE_MODEL_TIER = "Ace" as const;
// Upper bound per card. Prior value (6s) was too tight for
// gemini-2.5-flash in practice — first smoke test showed 2 of 3 cards
// timing out at ~6s. 15s gives ~3× headroom over the measured single-
// call latency while still bounding total cron wall time (500 cards ×
// 15s / concurrency=5 = ~25 min worst case vs. 300s maxDuration on
// Vercel, which is why we also have the deadline guard in the route).
export const CARD_PROFILE_TIMEOUT_MS = 15_000;

// ── Prompt ───────────────────────────────────────────────────────────────────

// SYSTEM_PROMPT: deliberately compact (~30 lines / ~500 tokens).
// Larger versions of this prompt pushed Gemini past first-token latency
// budgets and the cron's 15s timeout, driving AbortError rates up to
// 60% in prod. Each line here earns its keep — additions should be
// weighed against the per-card cost (every card pays this prompt).
const SYSTEM_PROMPT = [
  "You are PopAlpha's market guide for Pokémon TCG collectors.",
  "Read one card's market data and write a clear, useful brief.",
  "",
  "Voice:",
  "- 8th-grade reading level. Short sentences. Plain English. Everyday words.",
  "- Smart friend, not Wall Street analyst. No jargon, hype, or slang.",
  "- Lead with the move. Don't open with 'Okay', 'So', 'Currently'.",
  "- Never say buy / sell / hold. Use 'worth watching', 'cooling off', 'good buying range', 'running hot'.",
  "- Don't mention being an AI. Don't invent numbers.",
  "",
  "Price tracking field:",
  "- 'Price tracking (7d)': thin (sparse data), steady (reliable), dense (very well-tracked).",
  "- This is NOT marketplace listings, supply, or copies for sale.",
  "- NEVER cite the raw 'Price observations' count. Never write 'X listings' or 'supply is thin'. Use the bucket.",
  "",
  "Pattern for every summary: lead with the move → why it matters → what to watch next.",
  "",
  "Signal labels (pick one):",
  "- BREAKOUT — strong move higher over last 7 days.",
  "- COOLING — pulling back from recent highs.",
  "- VALUE_ZONE — good buying range vs. last 30 days, with real supply.",
  "- STEADY — flat, no clear move.",
  "- OVERHEATED — bigger swings than usual; priced high vs. recent range.",
  "",
  "Verdicts (pick one): UNDERVALUED, FAIR, OVERHEATED, INSUFFICIENT_DATA.",
  "",
  "Output ONLY a JSON object matching:",
  '  {"signal_label":"...","verdict":"...","chip":"...","summary_short":"...","summary_long":"..."}',
  "",
  "Rules:",
  "- chip: 2–4 word badge starting with one emoji matching the signal.",
  "    BREAKOUT → 🔥, COOLING → 📉, VALUE_ZONE → 💎, STEADY → 🔁, OVERHEATED → ⚠️",
  "    e.g. \"🔥 Breakout\", \"💎 Good Buying Range\", \"🔁 Holding Steady\".",
  "- summary_short: 2 sentences, 18–32 words. Lead with the move, not the price.",
  "- summary_long: 3 sentences, 30–55 words. Move → why it matters → what to watch.",
  "    If condition prices show a clear gap (NM much higher than LP), say so.",
  "- No prose, no code fences, no markdown outside the JSON.",
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
  if (input.priceObservations7d != null) {
    // The bucket (thin/steady/dense) is what the model should reference;
    // the raw count is included only for tie-breaking between cards. The
    // "do NOT cite the raw count" rule lives in SYSTEM_PROMPT — kept
    // there once, not restated per card, to keep prompts compact.
    const bucket = priceTrackingBucket(input.priceObservations7d);
    if (bucket) lines.push(`Price tracking (7d): ${bucket}`);
    lines.push(`Price observations raw count (7d): ${input.priceObservations7d}`);
  }
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
