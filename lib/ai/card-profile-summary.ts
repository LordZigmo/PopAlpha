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
  // Rolled-up price-observation count over 7 days (DB column:
  // active_listings_7d). Defined as
  //   greatest(history_7d_count, snapshot_active_7d_count)
  // summed across printing variants — see migration
  // 20260304120000_refresh_card_metrics_use_history_counts.sql.
  // Dominated by data-provider price-history rows for popular cards
  // and uncapped (an earlier comment claiming a "*20-then-clamp" cap
  // was wrong — that cap is on liquidity_score). The absolute number
  // is not meaningful to a collector, so prompts and fallbacks
  // translate it to a qualitative bucket via priceTrackingBucket()
  // and never surface the raw count. NOT marketplace listings or
  // copies for sale.
  priceObservations7d: number | null;
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
//   priceObservations7d (DB column: active_listings_7d) — flickers from
//   rolling-window edge timing (a card's count can move ±1 just because
//   yesterday's poll fell outside the window today). Was triggering
//   pure-noise refreshes. Still passed to the LLM in the prompt for
//   qualitative reasoning context (thin/steady/dense bucket) — just
//   not used as a refresh trigger.
//
// Note on what priceObservations7d actually is: it's
//   greatest(history_7d_count, snapshot_active_7d_count)
// rolled up across all printing variants of the card (see migration
// 20260304120000_refresh_card_metrics_use_history_counts.sql lines
// 138-167). It is NOT capped — earlier comments in this file claimed a
// "*20-then-clamp" cap to 100, but that cap is on liquidity_score, not
// on this field. The number can run into the hundreds for popular
// cards with many variants, which is why we now translate it to a
// qualitative bucket (thin/steady/dense) before surfacing to users.
//
// Combined with changePct rounded to integers, this still catches:
//   - $0.50 → $1.00      (100% move; changePct flips 0 → 100)
//   - $20  → $21         (5% move;  changePct flips 0 → 5)
//   - $200 → $210        (same 5% logic at any price level)
// While suppressing:
//   - $4.97 → $4.98      (penny tick, narrative unchanged)
//   - 4.4% → 4.5%        (sub-percent move, within reporting precision)
//   - reads 14 → 15      (poll-edge flicker, no real activity change)

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
  VALUE_ZONE: "💎 Good Buying Range",
  STEADY: "🔁 Holding Steady",
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

// Translates the raw `priceObservations7d` count into a qualitative bucket.
// The raw number is technically meaningless to a reader (it's summed across
// printing variants over 7 days, with provider feeds dominating the count
// for popular cards). The bucket conveys the only thing that actually
// matters: how reliable today's price level is.
type PriceTrackingBucket = "thin" | "steady" | "dense";

export function priceTrackingBucket(count: number | null): PriceTrackingBucket | null {
  if (count == null || !Number.isFinite(count)) return null;
  if (count <= 4) return "thin";
  if (count < 30) return "steady";
  return "dense";
}

function formatSignedPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
}

export function buildFallbackProfile(input: CardProfileInput): CardProfileResult {
  const { canonicalName, setName, marketPrice, changePct7d, priceObservations7d } = input;
  const priceText = formatUsd(marketPrice);
  const changeText = formatSignedPct(changePct7d);
  const signal = pickSignal(input);
  const verdict = pickVerdict(input, signal);

  // Sentence 1 — what is happening (the move)
  let happeningLine: string;
  if (changeText && changePct7d != null && changePct7d > 0) {
    happeningLine = `${canonicalName} is up ${changeText} over the last 7 days, trading around ${priceText}.`;
  } else if (changeText && changePct7d != null && changePct7d < 0) {
    happeningLine = `${canonicalName} is down ${changeText} over the last 7 days, trading around ${priceText}.`;
  } else {
    happeningLine = `${canonicalName} is holding steady around ${priceText}.`;
  }

  // Sentence 2 — why it matters (signal-aware)
  let mattersLine: string;
  switch (signal) {
    case "BREAKOUT":
      mattersLine = "That is a strong move higher in a short window.";
      break;
    case "COOLING":
      mattersLine = "That is a clear pullback from recent highs.";
      break;
    case "VALUE_ZONE":
      mattersLine = "That puts it in a good buying range vs. the last 30 days.";
      break;
    case "OVERHEATED":
      mattersLine = "Price swings have been bigger than usual lately.";
      break;
    default:
      mattersLine = "There is no clear move in either direction right now.";
  }

  // Sentence 3 — what to watch next. The raw priceObservations7d count is
  // a rolled-up data-provider artifact (often in the dozens for popular
  // cards) and means nothing to a collector, so we translate to a
  // qualitative bucket and never surface the number itself.
  const bucket = priceTrackingBucket(priceObservations7d);
  let watchLine: string;
  switch (bucket) {
    case "thin":
      watchLine = "Price tracking on this card is thin, so the next sale will tell you a lot.";
      break;
    case "steady":
      watchLine = "Price tracking is steady — watch whether the move holds across the next few sales.";
      break;
    case "dense":
      watchLine = "Price tracking is dense, so a clean move shows up fast — watch whether it holds across the next few sales.";
      break;
    default:
      watchLine = "Watch whether the move holds across the next few sales.";
  }

  const summaryShort = `${happeningLine} ${mattersLine}`;
  const setContext = setName ? ` This card is from the ${setName} set.` : "";
  const summaryLong = `${happeningLine} ${mattersLine} ${watchLine}${setContext}`;

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
  "You are PopAlpha's market guide for Pokémon TCG collectors.",
  "Read one card's market data and write a clear, useful brief about it.",
  "",
  "Style:",
  "- 8th-grade reading level. Short sentences. Plain English.",
  "- Premium but not academic. Sound like a smart friend, not a Wall Street analyst.",
  "- No hype, no slang, no finance jargon.",
  "- Lead with the move. Do not start with 'Okay', 'So', 'Currently', or any setup phrase.",
  "- Never give buy / sell / hold advice. Use plain phrases like 'worth watching', 'cooling off', 'in a good buying range', 'running hot'.",
  "- Do not mention being an AI. Do not invent numbers that are not in the data.",
  "",
  "BANNED phrases — never use any of these:",
  "  broad activity, selective strength, distinct clusters, accumulation zone,",
  "  pricing dislocation, asymmetric upside, market regime, conviction, breadth,",
  "  stretched, dislocated, regime, asymmetric, decisive, fragile run.",
  "",
  "Field meanings (read carefully so you don't mislabel data):",
  "- 'Price tracking (7d)' is one of: thin, steady, dense.",
  "    thin   = sparse data; the next sale will tell us a lot.",
  "    steady = enough data to read the price reliably.",
  "    dense  = price is very well-tracked; a clean move shows up fast.",
  "- 'Price observations raw count (7d)' is internal only. NEVER cite this number to the reader (e.g., do not write '78 price reads', '12 listings', etc.). It is summed across printing variants and dominated by data-provider rows, so the absolute count is meaningless to a collector.",
  "- This metric is NOT a count of marketplace listings, copies for sale, supply, or sale events. Never say 'X listings', 'supply is thin', or 'only X copies for sale'.",
  "- Use the bucket to talk about how reliable the price is, not about supply.",
  "",
  "Use simpler words instead:",
  "  - 'accumulation zone' → 'good buying range'",
  "  - 'pricing dislocation' → 'price gap'",
  "  - 'asymmetric upside' → 'could have room to move'",
  "  - 'breadth is thin' → 'not many cards are moving with it'",
  "  - 'stretched' → 'priced high vs. recent range'",
  "",
  "Every summary follows this 3-step pattern:",
  "  1. What is happening? (lead with the move)",
  "  2. Why it matters. (what the price level or supply tells the collector)",
  "  3. What to watch next. (the next signal to keep an eye on)",
  "",
  "Signal labels (pick exactly one):",
  "- BREAKOUT   — strong move higher over the last 7 days.",
  "- COOLING    — pulling back from recent highs.",
  "- VALUE_ZONE — sitting in a good buying range vs. the last 30 days, with real supply.",
  "- STEADY     — holding flat. No clear move.",
  "- OVERHEATED — bigger price swings than usual. Priced high vs. recent range.",
  "",
  "Verdicts (pick exactly one):",
  "- UNDERVALUED        — price looks soft vs. the recent range.",
  "- FAIR               — price lines up with the recent range.",
  "- OVERHEATED         — price looks high vs. the recent range.",
  "- INSUFFICIENT_DATA  — not enough signal to call.",
  "",
  "Output ONLY a single JSON object matching this exact shape:",
  '  {"signal_label":"...","verdict":"...","chip":"...","summary_short":"...","summary_long":"..."}',
  "",
  "Field rules:",
  "- signal_label: one of BREAKOUT, COOLING, VALUE_ZONE, STEADY, OVERHEATED.",
  "- verdict: one of UNDERVALUED, FAIR, OVERHEATED, INSUFFICIENT_DATA.",
  "- chip: 2–4 word badge. Start with one emoji that matches the signal.",
  "    BREAKOUT → 🔥, COOLING → 📉, VALUE_ZONE → 💎, STEADY → 🔁, OVERHEATED → ⚠️.",
  "    Examples: \"🔥 Breakout\", \"📉 Cooling Off\", \"💎 Good Buying Range\", \"🔁 Holding Steady\", \"⚠️ Running Hot\".",
  "- summary_short: 2 short sentences, 18–32 words. Sentence 1 = what is happening.",
  "    Sentence 2 = why it matters or what to watch next. Lead with the move, not the price.",
  "- summary_long: 3 short sentences, 30–55 words. Use the 3-step pattern:",
  "    What is happening → Why it matters → What to watch next.",
  "    If condition prices show a clear gap (e.g. NM is much higher than LP), say so plainly.",
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
  if (input.priceObservations7d != null) {
    // The raw count is rolled up across printing variants over 7 days
    // and is dominated by provider price-history rows — it is NOT
    // marketplace listings, copies for sale, or sale events. Surface
    // the qualitative bucket (thin/steady/dense) for the model to use,
    // and pass the raw count only as an internal reasoning aid with an
    // explicit "do not cite" instruction.
    const bucket = priceTrackingBucket(input.priceObservations7d);
    if (bucket) {
      lines.push(`Price tracking (7d): ${bucket}`);
    }
    lines.push(
      `Price observations raw count (7d): ${input.priceObservations7d} ` +
      `(internal only — do NOT cite this number to the reader; it is rolled ` +
      `up across all printing variants and is not marketplace listings or sales)`,
    );
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
