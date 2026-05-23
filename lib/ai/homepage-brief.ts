import "server-only";

import { generateText } from "ai";

import { getPopAlphaGatewayModelId } from "@/lib/ai/model-config";
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
// Stored on generated brief rows so each entry carries its producing Gateway model.
export const HOMEPAGE_BRIEF_MODEL_LABEL = getPopAlphaGatewayModelId();
// Bumped from 8_000 to 15_000 in the same wave as card-profile-summary
// (commit 564ce8c) and personalization/llm. Gemini 2.5-flash p95 sits in
// the 5-10s range; 8s aborted enough briefs to be worth fixing
// proactively rather than waiting for the symptoms to surface.
export const HOMEPAGE_BRIEF_TIMEOUT_MS = 15_000;

export type HomepageBriefSource = "llm" | "fallback";
export type HomepageBriefMarket = "EN" | "JP";

export type HomepageBrief = {
  market: HomepageBriefMarket;
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
type BriefCardSnapshot = {
  name: string;
  setName: string | null;
  changePct: number | null;
  marketPrice: number | null;
  activeListings7d: number | null;
  yahooJpPrice: number | null;
  yahooJpPriceJpy: number | null;
  yahooJpSampleCount: number | null;
  snkrdunkPrice: number | null;
  snkrdunkPriceJpy: number | null;
  snkrdunkSampleCount: number | null;
};

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

function toBriefCardSnapshot(card: HomepageCard): BriefCardSnapshot {
  return {
    name: card.name,
    setName: card.set_name,
    changePct: card.change_pct,
    marketPrice: card.market_price,
    activeListings7d: card.active_listings_7d,
    yahooJpPrice: card.yahoo_jp_price,
    yahooJpPriceJpy: card.yahoo_jp_price_jpy,
    yahooJpSampleCount: card.yahoo_jp_sample_count,
    snkrdunkPrice: card.snkrdunk_price,
    snkrdunkPriceJpy: card.snkrdunk_price_jpy,
    snkrdunkSampleCount: card.snkrdunk_sample_count,
  };
}

type BriefContext = {
  market: HomepageBriefMarket;
  marketLabel: string;
  dataSourceLabel: string;
  asOf: string | null;
  moverSets: RankedSet[];
  pullbackSets: RankedSet[];
  topMovers: BriefCardSnapshot[];
  topPullbacks: BriefCardSnapshot[];
  topBreakouts: BriefCardSnapshot[];
  unusualCards: BriefCardSnapshot[];
  topMoverAvgPct: number | null;
  topPullbackAvgPct: number | null;
  breakoutCount: number;
  breakoutSets: RankedSet[];
  unusualCount: number;
  unusualSets: RankedSet[];
  dominantSet: string | null;
  tone: "concentrated" | "broad" | "mixed" | "selective";
  pricesRefreshedToday: number | null;
  trackedCardsWithLivePrice: number | null;
  coverageLabel: string | null;
};

function latestUpdatedAt(cards: HomepageCard[]): string | null {
  let latestMs: number | null = null;
  for (const card of cards) {
    if (!card.updated_at) continue;
    const ms = Date.parse(card.updated_at);
    if (!Number.isFinite(ms)) continue;
    latestMs = latestMs == null ? ms : Math.max(latestMs, ms);
  }
  return latestMs == null ? null : new Date(latestMs).toISOString();
}

function uniqueCardCount(cards: HomepageCard[]): number {
  return new Set(cards.map((card) => card.slug)).size;
}

export function buildHomepageBriefContext(
  data: HomepageData,
  options: { market?: HomepageBriefMarket } = {},
): BriefContext {
  const market = options.market ?? "EN";
  const isJp = market === "JP";
  const signalBoard = data.signal_board;
  const movers24 = isJp
    ? signalBoard.japanese_top_movers["24H"]
    : signalBoard.top_movers["24H"];
  const drops24 = isJp
    ? signalBoard.japanese_biggest_drops["24H"]
    : signalBoard.biggest_drops["24H"];
  const breakouts = isJp
    ? signalBoard.japanese_momentum["24H"]
    : signalBoard.breakouts;
  const unusual = isJp
    ? [...signalBoard.japanese_mid_movers, ...signalBoard.japanese_budget_movers]
    : signalBoard.unusual_volume;
  const marketCards = isJp
    ? [
        ...signalBoard.japanese_top_movers["24H"],
        ...signalBoard.japanese_biggest_drops["24H"],
        ...signalBoard.japanese_momentum["24H"],
        ...signalBoard.japanese_mid_movers,
        ...signalBoard.japanese_budget_movers,
        ...signalBoard.japanese,
      ]
    : [];

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
    market,
    marketLabel: isJp ? "Japanese market" : "English market",
    dataSourceLabel: isJp ? "Yahoo Japan and Snkrdunk" : "PopAlpha market feeds",
    asOf: isJp ? latestUpdatedAt(marketCards) : data.as_of,
    moverSets,
    pullbackSets,
    topMovers: moverSample.map(toBriefCardSnapshot),
    topPullbacks: pullbackSample.map(toBriefCardSnapshot),
    topBreakouts: breakouts.slice(0, 3).map(toBriefCardSnapshot),
    unusualCards: unusual.slice(0, 3).map(toBriefCardSnapshot),
    topMoverAvgPct,
    topPullbackAvgPct,
    breakoutCount: breakouts.length,
    breakoutSets,
    unusualCount: unusual.length,
    unusualSets,
    dominantSet,
    tone,
    pricesRefreshedToday: isJp ? null : data.prices_refreshed_today,
    trackedCardsWithLivePrice: isJp ? uniqueCardCount(marketCards) : data.tracked_cards_with_live_price,
    coverageLabel: isJp
      ? `${uniqueCardCount(marketCards).toLocaleString()} JP cards surfaced in live rails from Yahoo Japan and Snkrdunk.`
      : null,
  };
}

function formatPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatUsd(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function formatJpy(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCount(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value).toLocaleString();
}

function formatJpSourcePrice(card: BriefCardSnapshot): string | null {
  const sources = [
    {
      label: "Snkrdunk",
      usd: card.snkrdunkPrice,
      jpy: card.snkrdunkPriceJpy,
      sampleCount: card.snkrdunkSampleCount ?? 0,
    },
    {
      label: "Yahoo JP",
      usd: card.yahooJpPrice,
      jpy: card.yahooJpPriceJpy,
      sampleCount: card.yahooJpSampleCount ?? 0,
    },
  ].filter((source) =>
    (source.usd != null && Number.isFinite(source.usd))
    || (source.jpy != null && Number.isFinite(source.jpy))
  );
  sources.sort((left, right) => right.sampleCount - left.sampleCount);

  const source = sources[0];
  if (!source) return formatUsd(card.marketPrice);

  const jpy = formatJpy(source.jpy);
  const usd = formatUsd(source.usd);
  const sampleCount = formatCount(source.sampleCount > 0 ? source.sampleCount : null);
  const price = jpy && usd ? `${jpy} (${usd})` : jpy ?? usd;
  return `${source.label} ${price}${sampleCount ? `, ${sampleCount} samples` : ""}`;
}

function formatCardSnapshot(
  card: BriefCardSnapshot,
  market: HomepageBriefMarket = "EN",
): string {
  const label = card.setName ? `${card.name} (${card.setName})` : card.name;
  const observations = formatCount(card.activeListings7d);
  const metrics = [
    formatPct(card.changePct),
    market === "JP" ? formatJpSourcePrice(card) : formatUsd(card.marketPrice),
    observations ? `${observations} tracked observations` : null,
  ].filter(Boolean);
  return metrics.length > 0 ? `${label} (${metrics.join(", ")})` : label;
}

function formatCardList(
  cards: BriefCardSnapshot[],
  limit: number,
  market: HomepageBriefMarket = "EN",
): string {
  return cards.slice(0, limit).map((card) => formatCardSnapshot(card, market)).join("; ");
}

function stringifyContextForPrompt(ctx: BriefContext): string {
  const lines: string[] = [];
  lines.push(`Market: ${ctx.marketLabel}`);
  lines.push(`Data sources: ${ctx.dataSourceLabel}`);
  if (ctx.coverageLabel) {
    lines.push(`Coverage: ${ctx.coverageLabel}`);
  }
  const tracked = formatCount(ctx.trackedCardsWithLivePrice);
  const refreshed = formatCount(ctx.pricesRefreshedToday);
  if (!ctx.coverageLabel && (tracked || refreshed)) {
    lines.push(
      `Coverage: ${tracked ?? "unknown"} cards with live prices; ${refreshed ?? "unknown"} refreshed in the last day.`,
    );
  }
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
  if (ctx.topMovers.length > 0) {
    lines.push(`Top mover cards: ${formatCardList(ctx.topMovers, 5, ctx.market)}`);
  }
  if (ctx.pullbackSets.length > 0) {
    lines.push(`Pullback sets: ${ctx.pullbackSets.slice(0, 3).map((s) => s.name).join(", ")}`);
  }
  if (ctx.topPullbackAvgPct != null) {
    lines.push(`Top pullback avg change 24H: ${ctx.topPullbackAvgPct}%`);
  }
  if (ctx.topPullbacks.length > 0) {
    lines.push(`Top pullback cards: ${formatCardList(ctx.topPullbacks, 3, ctx.market)}`);
  }
  const breakoutLabel = ctx.market === "JP" ? "JP momentum signals" : "Breakout signals";
  lines.push(`${breakoutLabel}: ${ctx.breakoutCount}${ctx.breakoutSets[0] ? ` (lead: ${ctx.breakoutSets[0].name})` : ""}`);
  if (ctx.topBreakouts.length > 0) {
    lines.push(`${ctx.market === "JP" ? "JP momentum cards" : "Breakout cards"}: ${formatCardList(ctx.topBreakouts, 3, ctx.market)}`);
  }
  const unusualLabel = ctx.market === "JP"
    ? "JP mid/budget mover signals"
    : "Unusual observed activity signals";
  lines.push(`${unusualLabel}: ${ctx.unusualCount}${ctx.unusualSets[0] ? ` (lead: ${ctx.unusualSets[0].name})` : ""}`);
  if (ctx.unusualCards.length > 0) {
    lines.push(`Unusual activity cards: ${formatCardList(ctx.unusualCards, 3, ctx.market)}`);
  }
  return lines.join("\n");
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You are PopAlpha's market guide for Pokémon TCG collectors.",
  "Write a useful market brief that helps a collector understand what is happening today and where to look next.",
  "",
  "Style:",
  "- 8th-grade reading level. Short, decisive sentences.",
  "- SPECIFIC. Name the actual sets and cards driving today's action whenever possible.",
  "- Useful. Explain the market pattern, not just which sets are moving.",
  "- Include concrete facts from the data: changes, card names, set concentration, pullbacks, activity, or coverage.",
  "- Respect the market in the input. For Japanese market briefs, discuss JP-source pricing and do not leak English-market conclusions.",
  "- No hedging or filler. Skip vague phrasing.",
  "- No finance jargon, no hype, no slang.",
  "- Do not mention being an AI. Do not invent sets or numbers not in the data.",
  "",
  "BANNED phrases — never use any of these (or close variants):",
  "  \"a lot of cards are moving\", \"mixed energy\", \"various sets\", \"some cards\",",
  "  \"broad activity\", \"selective strength\", \"distinct clusters\", \"accumulation zone\",",
  "  \"pricing dislocation\", \"asymmetric upside\", \"market regime\", \"breadth\",",
  "  \"conviction\", \"rotation\", \"concentrating\", \"dominant pocket\", \"board-wide\",",
  "  \"good buying range\", \"market is showing\", \"market activity\".",
  "",
  "Replace vague language with specific, decisive language:",
  "  - Instead of \"a lot of cards are moving\" → \"151 and Astral Radiance are leading today\".",
  "  - Instead of \"mixed energy\" → \"momentum is selective\" or \"no single set is in charge\".",
  "  - Instead of \"some sets\" → name the actual sets from the data.",
  "  - Instead of \"various cards\" → name the specific set that's leading.",
  "",
  "The brief follows this exact 3-step pattern:",
  "  1. WHAT'S HAPPENING — 2 short sentences naming the leading sets/cards and the size of the move.",
  "     Example: \"151 is carrying today's board, led by Charizard ex and Mew ex. The top mover group is averaging +8.4%, while most other sets are quieter.\"",
  "  2. WHY IT MATTERS — 2 short sentences explaining what the action pattern tells the reader.",
  "     Example: \"This is a narrow move, not a full market rally. When one set owns most top movers, chasing weaker cards in other sets is riskier.\"",
  "  3. WHAT TO WATCH — 2 short, action-oriented sentences pointing at the next step.",
  "     Example: \"Watch whether 151 keeps its gains while pullback cards stop sliding. If unusual activity spreads to another set, tomorrow's leader may change.\"",
  "",
  "Output ONLY a single JSON object matching this exact shape:",
  '  {"summary":"...","whatsHappening":"...","whyItMatters":"...","whatToWatch":"...","takeaway":"...","focusSet":"..." | null}',
  "",
  "Field rules:",
  "- summary: 2-3 sentences (45-85 words total) shown collapsed on the home screen.",
  "    It should include the leading set/card pattern, one concrete number, and one useful next step.",
  "    Example: \"151 is doing most of the work today, led by Charizard ex and Mew ex while the top mover group averages +8.4%. That makes this a narrow rally, not a full market turn. Watch whether those gains hold while pullbacks stabilize.\"",
  "- whatsHappening: 2 short sentences (28-60 words total) for pattern step 1.",
  "- whyItMatters:   2 short sentences (28-60 words total) for pattern step 2.",
  "- whatToWatch:    2 short sentences (28-60 words total) for pattern step 3.",
  "- takeaway: 2–4 words. A decisive headline naming today's pattern. No trailing period.",
  "    Examples: \"Selective momentum\", \"151 leading\", \"Few sets pulling away\", \"Quiet day, watch breakouts\".",
  "- focusSet: the single most important set name from the data, or null if no set stands out.",
  "- Do not output anything outside the JSON object. No prose, no code fences, no markdown.",
].join("\n");

function buildUserPrompt(ctx: BriefContext): string {
  return [
    `Write today's PopAlpha ${ctx.marketLabel} AI Brief using only this data:`,
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
  const leader  = ctx.dominantSet;
  const second  = ctx.moverSets[1]?.name ?? null;
  const leaderCount = ctx.moverSets[0]?.count ?? 0;
  const moverAvg = formatPct(ctx.topMoverAvgPct);
  const pullbackAvg = formatPct(ctx.topPullbackAvgPct);
  const topMover = ctx.topMovers[0] ? formatCardSnapshot(ctx.topMovers[0], ctx.market) : null;
  const topMoverPair = ctx.topMovers.length >= 2 ? formatCardList(ctx.topMovers, 2, ctx.market) : topMover;
  const pullbackLeader = ctx.topPullbacks[0] ? formatCardSnapshot(ctx.topPullbacks[0], ctx.market) : null;
  const breakoutLeader = ctx.topBreakouts[0] ? formatCardSnapshot(ctx.topBreakouts[0], ctx.market) : null;
  const unusualLeader = ctx.unusualCards[0] ? formatCardSnapshot(ctx.unusualCards[0], ctx.market) : null;
  const tracked = formatCount(ctx.trackedCardsWithLivePrice);
  const refreshed = formatCount(ctx.pricesRefreshedToday);
  const coverageLine = tracked || refreshed
    ? `Coverage is based on ${tracked ?? "the tracked"} ${ctx.market === "JP" ? "JP " : ""}live-priced cards${refreshed ? `, with ${refreshed} refreshed in the last day` : ""}.`
    : null;
  const marketNoun = ctx.market === "JP" ? "JP market" : "market";
  const fullMarketNoun = ctx.market === "JP" ? "full JP market" : "full market";

  let whatsHappening: string;
  let whyItMatters:   string;
  let whatToWatch:    string;
  let summary:        string;
  let takeaway:       string;

  if (leader && leaderCount >= 3) {
    // Single set running the show. Specific and decisive.
    whatsHappening = `${leader} is carrying today's board, with ${leaderCount} of the top five movers from this set. ${topMover ? `${topMover} is the lead signal` : moverAvg ? `The top mover group is averaging ${moverAvg}` : `The move is concentrated rather than ${marketNoun}-wide`}.`;
    whyItMatters   = `This is a focused run, not a rally across the ${fullMarketNoun}. ${pullbackLeader ? `Pullbacks are still showing up, led by ${pullbackLeader}, so weak cards outside ${leader} need confirmation.` : "When one set owns most movers, weaker cards outside that set need confirmation before they matter."}`;
    whatToWatch    = `Watch whether ${leader} keeps adding movers and holds today's gains. ${unusualLeader ? `Also watch unusual activity in ${unusualLeader}, because that can show where demand spreads next.` : breakoutLeader ? `Also watch ${breakoutLeader}, because breakout cards show whether the move is widening.` : "If the move spreads beyond the first few cards, the run gets more durable."}`;
    summary        = `${leader} is carrying today's board, with ${leaderCount} of the top five movers from this set${moverAvg ? ` and the top group averaging ${moverAvg}` : ""}. This is a focused run, not a rally across the ${fullMarketNoun}. Watch whether gains hold and whether unusual activity spreads beyond the first few cards.`;
    takeaway       = `${leader} leading`;
  } else if (leader && second) {
    // Two-set lead. Name both — that's what makes it specific.
    whatsHappening = `${leader} and ${second} are sharing today's biggest moves, while the rest of the market is quieter. ${topMoverPair ? `The leaders are ${topMoverPair}.` : moverAvg ? `The top mover group is averaging ${moverAvg}.` : ""}`;
    whyItMatters   = `Demand is split across two sets, so there are opportunities in both but no clear leader across the ${marketNoun}. ${pullbackAvg ? `The pullback group is averaging ${pullbackAvg}, which means downside is still active too.` : "That makes confirmation more important than chasing the first spike."}`;
    whatToWatch    = `Watch which of ${leader} or ${second} keeps more cards green by the end of the day. ${breakoutLeader ? `${breakoutLeader} is the breakout signal to compare against the top movers.` : "The set that holds gains while pullbacks cool becomes the better next read."}`;
    summary        = `${leader} and ${second} are sharing today's strongest demand${moverAvg ? `, with top movers averaging ${moverAvg}` : ""}. The move is useful, but it is not broad enough to call a rally across the ${fullMarketNoun}. Watch which set holds gains while pullbacks cool.`;
    takeaway       = "Two sets pulling ahead";
  } else if (leader) {
    // One set, but thin participation. Still specific.
    const thinSignalDetail = topMover
      ? `${topMover} is the clearest signal.`
      : moverAvg
        ? `The top mover group is averaging ${moverAvg}.`
        : "The signal is narrow for now.";
    whatsHappening = `${leader} is the strongest set right now, but only a few cards are doing the work. ${thinSignalDetail}`;
    whyItMatters   = `Thin participation means a small group of cards is responsible for most of today's gains. ${coverageLine ?? "That can fade quickly unless more cards from the same set join the move."}`;
    whatToWatch    = `Watch for more ${leader} cards to join before treating this as a real run. ${pullbackLeader ? `If pullbacks like ${pullbackLeader} keep falling, keep position sizes small.` : "If the next update still shows only one or two movers, treat it as narrow demand."}`;
    summary        = `${leader} is leading today, but only a few cards are carrying the move${topMover ? `, led by ${topMover}` : ""}. Thin participation can fade quickly. Watch for more ${leader} cards to join before chasing.`;
    takeaway       = `${leader} carrying the day`;
  } else if ((ctx.topPullbackAvgPct ?? 0) < 0) {
    // Cool day. Still actionable.
    whatsHappening = `Pullbacks are louder than breakouts today${pullbackAvg ? `, with the pullback group averaging ${pullbackAvg}` : ""}. ${pullbackLeader ? `${pullbackLeader} is the clearest weak spot.` : "No single set is absorbing the whole move."}`;
    whyItMatters   = `When pullbacks outweigh gains, the ${marketNoun} is digesting recent moves instead of starting new ones. ${coverageLine ?? "That makes fresh highs less reliable until buyers return."}`;
    whatToWatch    = `Watch for the first set that finds a floor and bounces. ${unusualLeader ? `Unusual activity in ${unusualLeader} is worth checking because it may show where buyers return first.` : "The first bounce with real activity is more useful than another one-card spike."}`;
    summary        = `Pullbacks are louder than breakouts today${pullbackAvg ? `, with the pullback group averaging ${pullbackAvg}` : ""}. The ${marketNoun} is digesting recent moves instead of starting new ones. Watch for the first set that finds a floor and bounces with real activity.`;
    takeaway       = "Cool day, watch floors";
  } else {
    // Quiet day. Make the action useful anyway.
    whatsHappening = `The ${marketNoun} is quiet today, with no set pulling clearly ahead. ${coverageLine ?? "The signal board has enough data to watch, but not enough urgency to force a move."}`;
    whyItMatters   = "Quiet days are useful because they separate real follow-through from one-card noise. A set needs multiple cards moving together before it deserves attention.";
    whatToWatch    = `Watch for the first card or set that breaks out and gets confirmation through the afternoon. ${breakoutLeader ? `${breakoutLeader} is the first name to check.` : "If volume stays quiet, use today to build a watchlist instead of chasing."}`;
    summary        = `The ${marketNoun} is quiet today, with no clear leader or broad demand signal. That makes watchlists more useful than chasing. Watch for the first card or set that breaks out and gets confirmation through the afternoon.`;
    takeaway       = "Quiet day, watch breakouts";
  }

  return {
    market: ctx.market,
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
  if (!summary || summary.length > 900) return null;
  for (const part of [whatsHappening, whyItMatters, whatToWatch]) {
    if (part.length > 420) return null;
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
  options: { logger?: GenerateBriefLogger; market?: HomepageBriefMarket } = {},
): Promise<HomepageBrief> {
  const logger = options.logger ?? console;
  const ctx = buildHomepageBriefContext(data, { market: options.market });
  const startMs = Date.now();

  // Short-circuit the LLM when the homepage has no mover data. A fresh
  // install or a broken upstream feed would otherwise waste tokens to
  // produce a useless brief.
  if (ctx.moverSets.length === 0 && ctx.breakoutCount === 0 && ctx.unusualCount === 0) {
    logger.info("[homepage-brief] no mover data, using fallback");
    return buildFallbackHomepageBrief(ctx, ctx.asOf);
  }

  const system = SYSTEM_PROMPT;
  const prompt = buildUserPrompt(ctx);
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), HOMEPAGE_BRIEF_TIMEOUT_MS);

  try {
    const result = await generateText({
      model: getPopAlphaModel(),
      system,
      prompt,
      abortSignal: abortController.signal,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "homepage-brief",
        metadata: {
          market: ctx.market,
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
        ...buildFallbackHomepageBrief(ctx, ctx.asOf),
        failureReason: "parse-miss",
      };
    }

    const usage = result.totalUsage ?? {
      inputTokens: undefined,
      outputTokens: undefined,
    };
    const brief: HomepageBrief = {
      market: ctx.market,
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
      dataAsOf: ctx.asOf,
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
      ...buildFallbackHomepageBrief(ctx, ctx.asOf),
      failureReason: `llm-threw:${errName}:${errMsg.slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
