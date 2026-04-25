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
export const HOMEPAGE_BRIEF_TIMEOUT_MS = 8_000;

export type HomepageBriefSource = "llm" | "fallback";

export type HomepageBrief = {
  version: string;
  summary: string;
  takeaway: string;
  focusSet: string | null;
  modelLabel: string;
  source: HomepageBriefSource;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  dataAsOf: string | null;
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
  "You are PopAlpha's homepage market analyst for Pokémon TCG collectors.",
  "Your job is to write a tight, calm, useful market read for today's homepage card.",
  "Rules:",
  "- Write in plain English at an 8th-grade reading level.",
  "- Sound calm, sharp, and useful. Avoid hype, slang, and finance jargon.",
  "- Talk about the market in general terms. Refer to sets, clusters, breadth, and conviction rather than naming individual cards.",
  "- Do not mention being an AI. Do not invent metrics or sets that are not in the data.",
  "- Output ONLY a single JSON object matching this exact shape:",
  '  {"summary":"...","takeaway":"...","focusSet":"..." | null}',
  "- summary: exactly 2 sentences, 20–40 words total. Explain where strength or weakness is concentrating and whether the move looks broad or selective.",
  "- takeaway: one punchy phrase, 4–8 words, no trailing period. Treat it like a headline chip. Examples: \"Sealed modern leading breadth\", \"Rotation into classic holos\", \"Selective bid, no broad lift\".",
  "- focusSet: the single most important set name from the data, or null if no set dominates.",
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

  let summary: string;
  let takeaway: string;

  if (leader && leaderCount >= 3) {
    summary = `${leader} is leading the board today, with most of the strongest movers clustered in the same set. Breadth is still selective, so the rest of the market is participating more cautiously.`;
    takeaway = avg != null && avg > 0
      ? `${leader} +${avg}% avg 24H`
      : `${leader} leading breadth`;
  } else if (leader && ctx.moverSets.length >= 3) {
    summary = `Strength is split across ${leader} and a handful of other sets, so no single pocket has broken away. The board looks active but mixed, without a clear consensus leader.`;
    takeaway = "Mixed strength, no clear leader";
  } else if (leader) {
    summary = `${leader} looks strongest right now, but breadth is limited and the move is still narrow. The rest of the board has not confirmed a broader rotation yet.`;
    takeaway = `${leader} leads, breadth thin`;
  } else if ((ctx.topPullbackAvgPct ?? 0) < 0) {
    summary = "The market is in a quiet pullback with no single set in control. Strong bids are rare and breadth is thin across the board.";
    takeaway = "Quiet pullback, thin breadth";
  } else {
    summary = "The board is still taking shape today. No set has separated from the rest, so the next clear leader has not fully broken out yet.";
    takeaway = "Board waiting for a leader";
  }

  return {
    version: HOMEPAGE_BRIEF_VERSION,
    summary,
    takeaway,
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
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const takeaway = typeof obj.takeaway === "string" ? obj.takeaway.trim() : "";
  if (!summary || !takeaway) return null;
  if (summary.length > 400 || takeaway.length > 80) return null;
  const focusSet = typeof obj.focusSet === "string" && obj.focusSet.trim().length > 0
    ? obj.focusSet.trim()
    : null;
  return { summary, takeaway, focusSet };
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
      return buildFallbackHomepageBrief(ctx, data.as_of);
    }

    const usage = result.totalUsage ?? {
      inputTokens: undefined,
      outputTokens: undefined,
    };
    const brief: HomepageBrief = {
      version: HOMEPAGE_BRIEF_VERSION,
      summary: parsed.summary,
      takeaway: parsed.takeaway,
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
    const reason = err instanceof Error ? err.name || err.message : "unknown";
    logger.warn("[homepage-brief] LLM call failed, using fallback", { reason });
    return buildFallbackHomepageBrief(ctx, data.as_of);
  } finally {
    clearTimeout(timeoutId);
  }
}
