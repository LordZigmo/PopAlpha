import "server-only";

import { generateText } from "ai";

import { getPopAlphaModel } from "@/lib/ai/models";
import type { HomepageCard, HomepageData } from "@/lib/data/homepage";

/**
 * lib/ai/homepage-brief.ts
 *
 * Generates the cached AI Brief shown on the iOS and web homepage.
 *
 * Unlike the legacy `HOMEPAGE_SUMMARY_CONFIG` in app/page.tsx (which
 * produces a 2-paragraph narrative for the desktop Scout section), this
 * module produces a **structured** brief shaped for the iOS
 * `AIBriefCard` component:
 *
 *   {
 *     summary:  "2–3 sentence market read",
 *     takeaway: "1 punchy chip, 4–8 words",
 *     focusSet: "dominant set name or null"
 *   }
 *
 * The cron at /api/cron/refresh-ai-brief calls `generateHomepageBrief`
 * and inserts the result into `public.ai_brief_cache`. The public route
 * at /api/homepage/ai-brief reads from the `public_ai_brief_latest` view
 * and serves the brief to clients.
 *
 * If the LLM call fails (timeout, schema violation, empty output), this
 * module returns a deterministic fallback built from the homepage data
 * so the cache is never empty.
 */

export const HOMEPAGE_BRIEF_VERSION = "homepage-brief-v1";
export const HOMEPAGE_BRIEF_MODEL_TIER = "Ace" as const;
// Keep in sync with getPopAlphaModel("Ace"). Stored on generated
// brief rows so each entry carries its producing model.
export const HOMEPAGE_BRIEF_MODEL_LABEL = "gemini-2.5-flash";
// Bumped from 8_000 to 15_000 in the same wave as card-profile-summary
// (commit 564ce8c) and personalization/llm. Gemini 2.5-flash p95 sits in
// the 5-10s range; 8s aborted enough briefs to be worth fixing
// proactively rather than waiting for the symptoms to surface.
export const HOMEPAGE_BRIEF_TIMEOUT_MS = 15_000;

export type HomepageBriefSource = "llm" | "fallback";

export type HomepageBrief = {
  version: string;
  summary: string;
  takeaway: string;
  /// Labeled 3-step variant of the same content as `summary`. The
  /// homepage AI Brief card on iOS renders these as three captioned
  /// sections when expanded ("What's happening / Why it matters /
  /// What to watch"). All three are nullable for backward compat with
  /// older v1 cached briefs and the legitimate fallback path.
  whatsHappening: string | null;
  whyItMatters: string | null;
  whatToWatch: string | null;
  focusSet: string | null;
  modelLabel: string;
  source: HomepageBriefSource;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  dataAsOf: string | null;
  // Set only when source === "fallback" AND the LLM was actually
  // attempted — i.e. this is a degraded run, not the legitimate "no
  // mover data, skip the LLM" short-circuit. The cron route uses this
  // to flip ok:false on degradation while staying ok:true on the
  // intentional skip path. See docs/external-api-failure-modes.md.
  failureReason?: string;
};

// ── Data context ─────────────────────────────────────────────────────────────

type RankedSet = { name: string; count: number };

function rankSetCounts(setNames: Array<string | null | undefined>): RankedSet[] {
  const counts = new Map<string, number>();
  for (const value of setNames) {
    const setName = value?.trim();
    if (!setName) continue;
    counts.set(setName, (counts.get(setName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .map(([name, count]) => ({ name, count }));
}

function averagePct(values: Array<number | null | undefined>): number | null {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  return Math.round((finite.reduce((a, b) => a + b, 0) / finite.length) * 10) / 10;
}

function topByChange(cards: HomepageCard[], n: number, ascending = false): HomepageCard[] {
  return [...cards]
    .filter((c) => typeof c.change_pct === "number" && Number.isFinite(c.change_pct))
    .sort((a, b) => {
      const ac = a.change_pct ?? 0;
      const bc = b.change_pct ?? 0;
      return ascending ? ac - bc : bc - ac;
    })
    .slice(0, n);
}

type BriefContext = {
  asOf: string | null;
  moverSets: RankedSet[];
  pullbackSets: RankedSet[];
  topMoverAvgPct: number | null;
  topPullbackAvgPct: number | null;
  breakoutCount: number;
  breakoutSets: RankedSet[];
  unusualCount: number;
  unusualSets: RankedSet[];
  dominantSet: string | null;
  tone: "concentrated" | "broad" | "mixed" | "selective";
};

export function buildHomepageBriefContext(data: HomepageData): BriefContext {
  const movers24 = data.signal_board.top_movers["24H"];
  const drops24 = data.signal_board.biggest_drops["24H"];
  const breakouts = data.signal_board.breakouts;
  const unusual = data.signal_board.unusual_volume;

  const moverSample = topByChange(movers24, 5);
  const pullbackSample = topByChange(drops24, 3, true);

  const moverSets = rankSetCounts(moverSample.map((c) => c.set_name));
  const pullbackSets = rankSetCounts(pullbackSample.map((c) => c.set_name));
  const breakoutSets = rankSetCounts(breakouts.map((c) => c.set_name));
  const unusualSets = rankSetCounts(unusual.map((c) => c.set_name));

  const topMoverAvgPct = averagePct(moverSample.map((c) => c.change_pct));
  const topPullbackAvgPct = averagePct(pullbackSample.map((c) => c.change_pct));

  // Pick the dominant set from movers first, then breakouts, then unusual.
  const dominantSet = moverSets[0]?.name ?? breakoutSets[0]?.name ?? unusualSets[0]?.name ?? null;

  // Determine tone from the concentration of the top 5 mover sets.
  let tone: BriefContext["tone"] = "mixed";
  const leaderCount = moverSets[0]?.count ?? 0;
  const totalMovers = moverSample.length;
  if (totalMovers === 0) {
    tone = "mixed";
  } else if (leaderCount >= 3) {
    tone = "concentrated";
  } else if (moverSets.length >= 4) {
    tone = "broad";
  } else {
    tone = "selective";
  }

  return {
    asOf: data.as_of,
    moverSets,
    pullbackSets,
    topMoverAvgPct,
    topPullbackAvgPct,
    breakoutCount: breakouts.length,
    breakoutSets,
    unusualCount: unusual.length,
    unusualSets,
    dominantSet,
    tone,
  };
}

function stringifyContextForPrompt(ctx: BriefContext): string {
  const lines: string[] = [];
  lines.push(`Tone: ${ctx.tone}`);
  if (ctx.moverSets.length > 0) {
    const topSets = ctx.moverSets.slice(0, 3).map((s) => `${s.name} (${s.count})`).join(", ");
    lines.push(`Leading mover sets: ${topSets}`);
  } else {
    lines.push("Leading mover sets: none");
  }
  if (ctx.topMoverAvgPct != null) {
    lines.push(`Top mover avg change 24H: ${ctx.topMoverAvgPct >= 0 ? "+" : ""}${ctx.topMoverAvgPct}%`);
  }
  if (ctx.pullbackSets.length > 0) {
    lines.push(`Pullback sets: ${ctx.pullbackSets.slice(0, 3).map((s) => s.name).join(", ")}`);
  }
  if (ctx.topPullbackAvgPct != null) {
    lines.push(`Top pullback avg change 24H: ${ctx.topPullbackAvgPct}%`);
  }
  lines.push(`Breakout signals: ${ctx.breakoutCount}${ctx.breakoutSets[0] ? ` (lead: ${ctx.breakoutSets[0].name})` : ""}`);
  lines.push(`Unusual volume signals: ${ctx.unusualCount}${ctx.unusualSets[0] ? ` (lead: ${ctx.unusualSets[0].name})` : ""}`);
  return lines.join("\n");
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You are PopAlpha's market guide for Pokémon TCG collectors.",
  "Write a short, easy-to-read brief about what the market is doing today.",
  "",
  "Style:",
  "- 8th-grade reading level. Short sentences. Plain English.",
  "- Premium but not academic. Calm, clear, and useful.",
  "- Written for Pokémon collectors, not Wall Street analysts.",
  "- No hype, no slang, no finance jargon.",
  "- Do not mention being an AI. Do not invent sets or numbers that are not in the data.",
  "",
  "BANNED phrases — never use any of these:",
  "  broad activity, selective strength, distinct clusters, accumulation zone,",
  "  pricing dislocation, asymmetric upside, market regime, breadth, conviction,",
  "  rotation, concentrating, dominant pocket, board-wide.",
  "",
  "Use simpler words instead:",
  "  - 'broad activity' → 'a lot of cards are moving'",
  "  - 'selective strength' → 'the strongest gains are in a few areas'",
  "  - 'accumulation zone' → 'good buying range'",
  "  - 'pricing dislocation' → 'price gap'",
  "  - 'asymmetric upside' → 'could have room to move'",
  "  - 'market regime' → 'how the market is acting'",
  "  - 'breadth' → 'how many cards are moving'",
  "",
  "Each summary follows this 3-step pattern:",
  "  1. What is happening? (one short sentence)",
  "  2. Why it matters. (one short sentence)",
  "  3. What to watch next. (one short sentence)",
  "",
  "Output ONLY a single JSON object matching this exact shape:",
  '  {"whatsHappening":"...","whyItMatters":"...","whatToWatch":"...","takeaway":"...","focusSet":"..." | null}',
  "",
  "Field rules:",
  "- whatsHappening: one short sentence (10–18 words) answering pattern step 1.",
  "- whyItMatters:   one short sentence (10–18 words) answering pattern step 2.",
  "- whatToWatch:    one short sentence (10–18 words) answering pattern step 3.",
  "- takeaway: one short headline, 4–8 words, no trailing period.",
  "    Examples: \"Some vintage cards are heating up\", \"Mixed market, no clear leader\",",
  "    \"Modern sets quietly leading\", \"A few cards doing the work\".",
  "- focusSet: the single most important set name from the data, or null if no set stands out.",
  "- Do not output anything outside the JSON object. No prose, no code fences, no markdown.",
].join("\n");

function buildUserPrompt(ctx: BriefContext): string {
  return [
    "Write today's PopAlpha homepage AI Brief using only this data:",
    "",
    stringifyContextForPrompt(ctx),
    "",
    "Return ONLY the JSON object. No explanation.",
  ].join("\n");
}

// ── Deterministic fallback ───────────────────────────────────────────────────

export function buildFallbackHomepageBrief(
  ctx: BriefContext,
  dataAsOf: string | null,
): HomepageBrief {
  const leader = ctx.dominantSet;
  const leaderCount = ctx.moverSets[0]?.count ?? 0;
  const avg = ctx.topMoverAvgPct;

  let whatsHappening: string;
  let whyItMatters:   string;
  let whatToWatch:    string;
  let takeaway: string;

  if (leader && leaderCount >= 3) {
    whatsHappening = `${leader} is leading today.`;
    whyItMatters   = "Most of the biggest movers come from the same set, so the gains are not spread across the whole market.";
    whatToWatch    = `Watch whether other sets join in or ${leader} keeps doing the work.`;
    takeaway = avg != null && avg > 0
      ? `${leader} +${avg}% on average`
      : `${leader} is leading today`;
  } else if (leader && ctx.moverSets.length >= 3) {
    whatsHappening = `${leader} is moving, but a few other sets are moving too.`;
    whyItMatters   = "No single set is in charge today.";
    whatToWatch    = "Watch which set holds its gains by the end of the day.";
    takeaway = "Mixed market, no clear leader";
  } else if (leader) {
    whatsHappening = `${leader} looks strongest right now, but only a few cards are doing the work.`;
    whyItMatters   = "The rest of the market is still quiet.";
    whatToWatch    = "Watch for more sets to join before calling this a real run.";
    takeaway = `${leader} leads, but quietly`;
  } else if ((ctx.topPullbackAvgPct ?? 0) < 0) {
    whatsHappening = "The market is cooling off today.";
    whyItMatters   = "Most cards are flat or slipping, and very few are bid up.";
    whatToWatch    = "Watch for the first set that finds a floor and bounces.";
    takeaway = "Cool day, few bids";
  } else {
    whatsHappening = "The market is quiet today.";
    whyItMatters   = "No set has pulled ahead yet, so it is hard to say where the next move comes from.";
    whatToWatch    = "Watch for the first card or set that breaks out.";
    takeaway = "Market is quiet today";
  }

  // Concatenated `summary` is the legacy single-blob form, kept around
  // for older clients reading the v1 shape.
  const summary = [whatsHappening, whyItMatters, whatToWatch].join(" ");

  return {
    version: HOMEPAGE_BRIEF_VERSION,
    summary,
    takeaway,
    whatsHappening,
    whyItMatters,
    whatToWatch,
    focusSet: leader,
    modelLabel: HOMEPAGE_BRIEF_MODEL_LABEL,
    source: "fallback",
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    dataAsOf,
  };
}

// ── JSON extraction ──────────────────────────────────────────────────────────

type ParsedLlmBrief = {
  summary: string;
  takeaway: string;
  focusSet: string | null;
  whatsHappening: string | null;
  whyItMatters: string | null;
  whatToWatch: string | null;
};

/**
 * Strip common decorations (code fences, leading prose) and extract the
 * first balanced JSON object from the raw LLM output.
 */
function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  let text = raw.trim();
  // Remove markdown code fences if the model ignored the "no code fences" rule.
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

function parseLlmBrief(raw: string): ParsedLlmBrief | null {
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
  const takeaway = typeof obj.takeaway === "string" ? obj.takeaway.trim() : "";
  if (!takeaway || takeaway.length > 80) return null;

  // 3-step fields are the primary path. We also accept a legacy
  // single-`summary` blob for backward compat with older prompts that
  // might still be in flight; the cron will catch up on the next tick.
  const cleanSection = (key: string): string => {
    const v = obj[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const whatsHappening = cleanSection("whatsHappening");
  const whyItMatters   = cleanSection("whyItMatters");
  const whatToWatch    = cleanSection("whatToWatch");

  let summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!summary && (whatsHappening || whyItMatters || whatToWatch)) {
    // Synthesize the legacy `summary` field from the 3 steps so older
    // clients that read only `summary` still see complete content.
    summary = [whatsHappening, whyItMatters, whatToWatch]
      .filter(Boolean)
      .join(" ");
  }
  if (!summary || summary.length > 600) return null;
  for (const part of [whatsHappening, whyItMatters, whatToWatch]) {
    if (part.length > 220) return null;
  }

  const focusSet = typeof obj.focusSet === "string" && obj.focusSet.trim().length > 0
    ? obj.focusSet.trim()
    : null;

  return {
    summary,
    takeaway,
    focusSet,
    whatsHappening: whatsHappening || null,
    whyItMatters:   whyItMatters   || null,
    whatToWatch:    whatToWatch    || null,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

export type GenerateBriefLogger = Pick<Console, "error" | "info" | "warn">;

export async function generateHomepageBrief(
  data: HomepageData,
  options: { logger?: GenerateBriefLogger } = {},
): Promise<HomepageBrief> {
  const logger = options.logger ?? console;
  const ctx = buildHomepageBriefContext(data);
  const startMs = Date.now();

  // Short-circuit the LLM when the homepage has no mover data. A fresh
  // install or a broken upstream feed would otherwise waste tokens to
  // produce a useless brief.
  if (ctx.moverSets.length === 0 && ctx.breakoutCount === 0 && ctx.unusualCount === 0) {
    logger.info("[homepage-brief] no mover data, using fallback");
    return buildFallbackHomepageBrief(ctx, data.as_of);
  }

  const system = SYSTEM_PROMPT;
  const prompt = buildUserPrompt(ctx);
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), HOMEPAGE_BRIEF_TIMEOUT_MS);

  try {
    const result = await generateText({
      model: getPopAlphaModel(HOMEPAGE_BRIEF_MODEL_TIER),
      system,
      prompt,
      abortSignal: abortController.signal,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "homepage-brief",
        metadata: {
          tone: ctx.tone,
          ...(ctx.dominantSet ? { dominant_set: ctx.dominantSet } : {}),
        },
      },
    });
    const parsed = parseLlmBrief(result.text ?? "");
    if (!parsed) {
      logger.warn("[homepage-brief] LLM output failed parse, using fallback", {
        rawPreview: (result.text ?? "").slice(0, 200),
      });
      return {
        ...buildFallbackHomepageBrief(ctx, data.as_of),
        failureReason: "parse-miss",
      };
    }

    const usage = result.totalUsage ?? {
      inputTokens: undefined,
      outputTokens: undefined,
    };
    const brief: HomepageBrief = {
      version: HOMEPAGE_BRIEF_VERSION,
      summary: parsed.summary,
      takeaway: parsed.takeaway,
      whatsHappening: parsed.whatsHappening,
      whyItMatters:   parsed.whyItMatters,
      whatToWatch:    parsed.whatToWatch,
      // If the LLM returned a focus set, prefer it; else fall back to our derived dominant set.
      focusSet: parsed.focusSet ?? ctx.dominantSet,
      modelLabel: HOMEPAGE_BRIEF_MODEL_LABEL,
      source: "llm",
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
      outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
      durationMs: Date.now() - startMs,
      dataAsOf: data.as_of,
    };
    logger.info("[homepage-brief] generated", {
      durationMs: brief.durationMs,
      inputTokens: brief.inputTokens,
      outputTokens: brief.outputTokens,
      takeaway: brief.takeaway,
    });
    return brief;
  } catch (err) {
    // Logging here was already in place; the change is to ALSO
    // propagate the reason through the returned HomepageBrief so the
    // cron consumer can flag a degraded run instead of silently
    // writing fallback content into ai_brief_cache and returning
    // ok:true. Without this, Vercel logs were the only place a real
    // outage surfaced — same anti-pattern as the card-profile cron
    // before commit e3f2549.
    const errName = err instanceof Error ? err.name : "UnknownError";
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn("[homepage-brief] LLM call failed, using fallback", {
      reason: `${errName}: ${errMsg}`,
    });
    return {
      ...buildFallbackHomepageBrief(ctx, data.as_of),
      failureReason: `llm-threw:${errName}:${errMsg.slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
