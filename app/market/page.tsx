import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { getHomepageData, type HomepageCard } from "@/lib/data/homepage";
import { getCommunityPulseSnapshot } from "@/lib/data/community-pulse";
import { getPopAlphaModel } from "@/lib/ai/models";
import HomepageSignalBoard from "@/components/homepage-signal-board";
import HomepageSearch from "@/components/homepage-search";
import SiteHeader from "@/components/site-header";
import TypewriterText from "@/components/typewriter-text";
import type { Metadata } from "next";

export const metadata: Metadata = {
  alternates: { canonical: "/market" },
};

export const revalidate = 60;

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatPct(n: number | null): string {
  if (n == null) return "--";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatExactCount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US").format(value);
}

function getChangeWindowBadge(cards: HomepageCard[], fallback = "Live"): string {
  const windows = [...new Set(cards.map((card) => card.change_window).filter((value): value is "24H" | "7D" => value === "24H" || value === "7D"))];
  if (windows.length === 0) return fallback;
  if (windows.length === 1) return windows[0];
  return "24H + 7D";
}

const EMPTY_DATA: {
  movers: HomepageCard[];
  high_confidence_movers: HomepageCard[];
  emerging_movers: HomepageCard[];
  losers: HomepageCard[];
  trending: HomepageCard[];
  signal_board: {
    top_movers: { "24H": HomepageCard[]; "7D": HomepageCard[] };
    biggest_drops: { "24H": HomepageCard[]; "7D": HomepageCard[] };
    momentum: { "24H": HomepageCard[]; "7D": HomepageCard[] };
    unusual_volume: HomepageCard[];
    breakouts: HomepageCard[];
  };
  as_of: string | null;
  prices_refreshed_today: number | null;
  tracked_cards_with_live_price: number | null;
} = {
  movers: [],
  high_confidence_movers: [],
  emerging_movers: [],
  losers: [],
  trending: [],
  signal_board: {
    top_movers: { "24H": [], "7D": [] },
    biggest_drops: { "24H": [], "7D": [] },
    momentum: { "24H": [], "7D": [] },
    unusual_volume: [],
    breakouts: [],
  },
  as_of: null,
  prices_refreshed_today: null,
  tracked_cards_with_live_price: null,
};
const DATA_TIMEOUT_MS = 30_000;
const AI_TIMEOUT_MS = 4_000;

const TRENDING_SET_PILLS = [
  "Prismatic Evolutions",
  "151",
  "Evolving Skies",
  "Crown Zenith",
  "Paldean Fates",
] as const;

const HERO_HEADLINE = "Market intelligence";
const HERO_HEADLINE_ACCENT = "for Pokémon collectors";
const HERO_SUBHEADLINE = "See which cards and sets are moving today, why it matters, and what to watch next.";
const HERO_PRIMARY_CTA = "Start free";
const HERO_SECONDARY_CTA = "Read live brief";
const HOMEPAGE_SCOUT_NARRATIVE =
  "Only a few chase cards are doing the work today. The move has not spread to the rest of the market yet. Watch whether deeper cards and sealed product start to follow.";

type PopAlphaTier = "Trainer" | "Ace" | "Elite";
type HomepageSummaryCommunityCard = {
  name: string;
  setName: string | null;
  bullishVotes: number;
  bearishVotes: number;
  changePct: number | null;
};
type HomepageSummaryConfig = {
  version: string;
  modelTier: PopAlphaTier;
  modelLabel: string;
  timeoutMs: number;
  logKey: string;
  sourceLimits: {
    topMovers: number;
    trending: number;
    losers: number;
    communityPulse: number;
  };
  pricingUsdPerMillionTokens: {
    input: number;
    output: number;
  };
  system: {
    role: string;
    style: readonly string[];
    structure: readonly string[];
    guardrails: readonly string[];
  };
  prompt: {
    task: string;
    focus: readonly string[];
  };
};

const HOMEPAGE_SUMMARY_CONFIG = {
  version: "homepage-summary-v2",
  modelTier: "Ace",
  modelLabel: "gemini-2.0-flash",
  timeoutMs: AI_TIMEOUT_MS,
  logKey: "[homepage.ai-summary]",
  sourceLimits: {
    topMovers: 2,
    trending: 2,
    losers: 1,
    communityPulse: 3,
  },
  pricingUsdPerMillionTokens: {
    input: 0.1,
    output: 0.4,
  },
  system: {
    role: "You are PopAlpha Ace Summary, a premium market note for the homepage.",
    style: [
      "8th-grade reading level. Short sentences. Plain English.",
      "Premium but not academic. Calm, clear, useful.",
      "Written for Pokémon collectors, not Wall Street analysts.",
      "No hype, no slang, no finance jargon.",
      "BANNED phrases: broad activity, selective strength, distinct clusters, accumulation zone, pricing dislocation, asymmetric upside, market regime, breadth, conviction, rotation, concentrating.",
      "Use simpler words: 'a lot of cards are moving' not 'broad activity'; 'the strongest gains are in a few areas' not 'selective strength'; 'good buying range' not 'accumulation zone'; 'how many cards are moving' not 'breadth'.",
    ],
    structure: [
      "Use the supplied market, set, pullback, and community vote signals.",
      "Write exactly 2 short paragraphs.",
      "No more than 2 sentences per paragraph.",
      "Paragraph 1 = what is happening. Talk about which sets or kinds of cards are moving and whether the move is wide or narrow.",
      "Paragraph 2 = why it matters and what to watch next. Use community votes to back up or push back on the move.",
    ],
    guardrails: [
      "Talk about the market in general terms — sets and groups of cards, not individual card names.",
      "Do not mention specific cards by name.",
      "Do not mention being an AI, and do not invent numbers.",
    ],
  },
  prompt: {
    task: "Write a short market read for Pokémon collectors using only the supplied homepage and community pulse data.",
    focus: [
      "What is the clearest move today — up or down, wide or narrow?",
      "Why does it matter for a collector reading this?",
      "Are collector votes backing up the move, or pushing back?",
      "Keep it short, plain, and useful.",
    ],
  },
} as const satisfies HomepageSummaryConfig;

function getTierLabel(value: unknown): PopAlphaTier {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "elite") return "Elite";
  if (normalized === "ace") return "Ace";
  return "Trainer";
}

function buildMarketNarrative(
  tier: PopAlphaTier,
  movers: HomepageCard[],
  losers: HomepageCard[],
  trending: HomepageCard[],
): string {
  const allCards = [...movers, ...trending, ...losers];
  const setCounts = new Map<string, number>();
  for (const card of allCards) {
    const setName = card.set_name?.trim();
    if (!setName) continue;
    setCounts.set(setName, (setCounts.get(setName) ?? 0) + 1);
  }
  const rankedSets = [...setCounts.entries()].sort((a, b) => b[1] - a[1]);
  const leader = rankedSets[0]?.[0];
  const runnerUp = rankedSets[1]?.[0];

  if (!leader) {
    return "The market is still mixed. No set is clearly in control yet.";
  }
  if ((rankedSets[0]?.[1] ?? 0) >= 3) {
    return `${leader} is leading today. The strongest moves keep showing up in the same set.`;
  }
  if (runnerUp) {
    return `The action is split between ${leader} and ${runnerUp}. No single set is taking over yet.`;
  }
  return `${leader} looks strongest right now, but the rest of the market still feels selective.`;
}

function rankSetCounts(setNames: Array<string | null | undefined>): Array<{ name: string; count: number }> {
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

function buildAceNarrativeFallback(
  movers: HomepageCard[],
  trending: HomepageCard[],
  losers: HomepageCard[],
  communityCards: HomepageSummaryCommunityCard[],
): string {
  const rankedSets = rankSetCounts([
    ...movers.map((card) => card.set_name),
    ...trending.map((card) => card.set_name),
    ...losers.map((card) => card.set_name),
  ]);
  const leaderSet = rankedSets[0] ?? null;
  const runnerUpSet = rankedSets[1] ?? null;
  const communitySets = rankSetCounts(communityCards.map((card) => card.setName));
  const communityVotes = communityCards.reduce((totals, card) => ({
    bullish: totals.bullish + card.bullishVotes,
    total: totals.total + card.bullishVotes + card.bearishVotes,
  }), { bullish: 0, total: 0 });
  const communityPct = communityVotes.total > 0
    ? Math.round((communityVotes.bullish / communityVotes.total) * 100)
    : null;

  if (leaderSet && leaderSet.count >= 3) {
    return `${leaderSet.name} is leading today. The biggest movers are coming from this set, while the rest of the market is moving more slowly.\n\n${communityPct != null ? `Community Pulse is ${communityPct}% bullish${communitySets[0] ? `, with the most support around ${communitySets[0].name}.` : "."}` : "Community Pulse will show whether more collectors get behind the move."} Watch whether other sets start to follow ${leaderSet.name}.`;
  }
  if (leaderSet && runnerUpSet) {
    return `${leaderSet.name} and ${runnerUpSet.name} are both moving, so the market is mixed today. No single set is in charge yet.\n\n${communityPct != null ? `Community Pulse is ${communityPct}% bullish, so collectors are leaning positive but still waiting to see which set takes the lead.` : "Community Pulse will show which set collectors get behind first."} Watch which set holds its gains by the end of the day.`;
  }
  if (leaderSet) {
    return `${leaderSet.name} looks strongest right now, but only a few cards are doing the work. The rest of the market has not really moved yet.\n\n${communityPct != null ? `Community Pulse is ${communityPct}% bullish${communitySets[0] ? `, with the most support around ${communitySets[0].name}.` : "."}` : "Community Pulse will show whether collector votes line up with the move."} Watch whether more cards in ${leaderSet.name} keep climbing too.`;
  }
  return "The market is still quiet. Only a few cards are moving, and no clear leader has shown up yet.\n\nCommunity Pulse still matters because it can show where collectors are paying attention first. Watch for attention, price moves, and votes to start lining up around the same group of cards.";
}

function normalizeAceSummary(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const explicitParagraphs = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (explicitParagraphs.length >= 2) return `${explicitParagraphs[0]}\n\n${explicitParagraphs[1]}`;
  const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((p) => p.trim()).filter(Boolean) ?? [trimmed];
  if (sentences.length <= 1) return `${trimmed}\n\nThe board is worth watching, but the next edge depends on where conviction builds.`;
  const mid = Math.ceil(sentences.length / 2);
  return `${sentences.slice(0, mid).join(" ").trim()}\n\n${sentences.slice(mid).join(" ").trim() || "The board is worth watching, but the next edge depends on where conviction builds."}`;
}

function splitAcePreview(text: string): { lead: string; remainder: string } {
  const flattened = text.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  if (!flattened) return { lead: "", remainder: "" };
  const firstSentence = flattened.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/)?.[0]?.trim() ?? flattened;
  const remainder = flattened.slice(firstSentence.length).trim();
  return { lead: firstSentence, remainder };
}

function buildHomepageSummaryContext(
  config: HomepageSummaryConfig,
  movers: HomepageCard[],
  trending: HomepageCard[],
  losers: HomepageCard[],
  communityCards: HomepageSummaryCommunityCard[],
): string {
  const moverSample = movers.slice(0, config.sourceLimits.topMovers);
  const trendingSample = trending.slice(0, config.sourceLimits.trending);
  const loserSample = losers.slice(0, config.sourceLimits.losers);
  const communitySample = communityCards.slice(0, config.sourceLimits.communityPulse);
  const marketSample = [...moverSample, ...trendingSample, ...loserSample];
  const rankedSets = rankSetCounts(marketSample.map((card) => card.set_name));
  const moverSets = rankSetCounts(moverSample.map((card) => card.set_name));
  const communitySets = rankSetCounts(communitySample.map((card) => card.setName));
  const positiveSignals = marketSample.filter((card) => (card.change_pct ?? 0) > 0).length;
  const negativeSignals = marketSample.filter((card) => (card.change_pct ?? 0) < 0).length;
  const averageMoverChange = averageValues(moverSample.map((card) => card.change_pct));
  const averageTrendChange = averageValues(trendingSample.map((card) => card.change_pct));
  const pullbackChange = loserSample[0]?.change_pct ?? null;
  const communityVotes = communitySample.reduce((totals, card) => ({
    bullish: totals.bullish + card.bullishVotes,
    total: totals.total + card.bullishVotes + card.bearishVotes,
  }), { bullish: 0, total: 0 });
  const communityBullishPct = communityVotes.total > 0
    ? Math.round((communityVotes.bullish / communityVotes.total) * 100)
    : null;

  return [
    `How many cards are moving: ${positiveSignals} going up, ${negativeSignals} going down, across ${rankedSets.length} active sets.`,
    moverSets[0]
      ? `Where the move is strongest: ${moverSets[0].name} is leading${moverSets[1] ? `, with ${moverSets[1].name} also moving.` : "."}`
      : "Where the move is strongest: no single set is in charge yet.",
    `Price changes: top movers up about ${averageMoverChange != null ? `${averageMoverChange.toFixed(1)}%` : "unknown"}, trending cards up about ${averageTrendChange != null ? `${averageTrendChange.toFixed(1)}%` : "unknown"}, biggest pullback ${pullbackChange != null ? `${pullbackChange.toFixed(1)}%` : "unknown"}.`,
    communityBullishPct != null
      ? `Community pulse: ${communityBullishPct}% bullish across ${communityVotes.total} votes${communitySets[0] ? `, with the most support around ${communitySets[0].name}.` : "."}`
      : "Community pulse: not enough votes yet to call.",
  ].join("\n");
}

function buildHomepageSummaryPrompt(config: HomepageSummaryConfig, topContext: string): { system: string; prompt: string } {
  return {
    system: [
      config.system.role,
      ...config.system.style,
      ...config.system.structure,
      ...config.system.guardrails,
    ].join(" "),
    prompt: [
      config.prompt.task,
      ...config.prompt.focus,
      "",
      topContext,
    ].join("\n"),
  };
}

function estimateHomepageSummaryCostUsd(
  config: HomepageSummaryConfig,
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
  },
): number | null {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;

  if (inputTokens == null && outputTokens == null) return null;

  const inputCost = ((inputTokens ?? 0) / 1_000_000) * config.pricingUsdPerMillionTokens.input;
  const outputCost = ((outputTokens ?? 0) / 1_000_000) * config.pricingUsdPerMillionTokens.output;
  return Number((inputCost + outputCost).toFixed(6));
}

function logHomepageSummaryUsage(
  config: HomepageSummaryConfig,
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  },
  meta: {
    durationMs: number;
    finishReason: string;
  },
): void {
  console.info(config.logKey, JSON.stringify({
    event: "usage",
    version: config.version,
    modelTier: config.modelTier,
    modelLabel: config.modelLabel,
    durationMs: meta.durationMs,
    finishReason: meta.finishReason,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: estimateHomepageSummaryCostUsd(config, usage),
  }));
}

function getHomepageSummaryFailureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "timeout";
    return error.message || error.name;
  }
  return "unknown";
}

function logHomepageSummaryFallback(
  config: HomepageSummaryConfig,
  durationMs: number,
  reason: string,
): void {
  console.info(config.logKey, JSON.stringify({
    event: "fallback",
    version: config.version,
    modelTier: config.modelTier,
    modelLabel: config.modelLabel,
    durationMs,
    reason,
  }));
}

function averageValues(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function getLeadingSet(cards: HomepageCard[]): { name: string | null; count: number } {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const setName = card.set_name?.trim();
    if (!setName) continue;
    counts.set(setName, (counts.get(setName) ?? 0) + 1);
  }

  const leader = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  })[0];

  return {
    name: leader?.[0] ?? null,
    count: leader?.[1] ?? 0,
  };
}

function buildFocusPills(cards: HomepageCard[], fallback: readonly string[], limit = 4): string[] {
  const seen = new Set<string>();
  const names = [
    ...cards.map((card) => card.set_name?.trim() ?? "").filter(Boolean),
    ...fallback,
  ];
  const pills: string[] = [];

  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pills.push(name);
    if (pills.length >= limit) break;
  }

  return pills;
}

function splitIntoSentences(text: string): string[] {
  return text
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean)
    ?? [];
}

function buildHeroBriefFallback(
  pulseCards: HomepageCard[],
  leaderSet: { name: string | null; count: number },
  fallback: string,
): { lead: string; secondary: string | null } {
  const positiveCount = pulseCards.filter((card) => (card.change_pct ?? 0) > 0).length;

  if (leaderSet.name && leaderSet.count >= 3) {
    return {
      lead: `Momentum is clustering in ${leaderSet.name}.`,
      secondary: `${leaderSet.count} cards are moving together.`,
    };
  }

  if (leaderSet.name && leaderSet.count >= 2) {
    return {
      lead: `Momentum is forming in ${leaderSet.name}.`,
      secondary: `${leaderSet.count} cards are moving together.`,
    };
  }

  if (positiveCount >= 3) {
    return {
      lead: "Today's strength is broad, not isolated.",
      secondary: `${positiveCount} names are participating.`,
    };
  }

  if (leaderSet.name) {
    return {
      lead: `${leaderSet.name} looks strongest right now.`,
      secondary: "Only a few cards are doing the work so far.",
    };
  }

  return {
    lead: fallback,
    secondary: null,
  };
}

function buildHeroBrief(
  summary: string,
  pulseCards: HomepageCard[],
  leaderSet: { name: string | null; count: number },
  fallback: string,
): { lead: string; secondary: string | null } {
  const summarySentences = splitIntoSentences(summary);
  const fallbackBrief = buildHeroBriefFallback(pulseCards, leaderSet, fallback);

  if (summarySentences.length === 0) {
    return fallbackBrief;
  }

  return {
    lead: summarySentences[0] ?? fallbackBrief.lead,
    secondary: summarySentences.slice(1, 3).join(" ").trim() || fallbackBrief.secondary,
  };
}

async function generateAceSummary(
  movers: HomepageCard[],
  trending: HomepageCard[],
  losers: HomepageCard[],
  communityCards: HomepageSummaryCommunityCard[],
): Promise<string> {
  const fallback = buildAceNarrativeFallback(movers, trending, losers, communityCards);
  const topContext = buildHomepageSummaryContext(HOMEPAGE_SUMMARY_CONFIG, movers, trending, losers, communityCards);
  const { system, prompt } = buildHomepageSummaryPrompt(HOMEPAGE_SUMMARY_CONFIG, topContext);
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), HOMEPAGE_SUMMARY_CONFIG.timeoutMs);
  const startedAt = performance.now();

  try {
    const result = await generateText({
      model: getPopAlphaModel(HOMEPAGE_SUMMARY_CONFIG.modelTier),
      abortSignal: abortController.signal,
      system,
      prompt,
    });
    clearTimeout(timeoutId);
    logHomepageSummaryUsage(HOMEPAGE_SUMMARY_CONFIG, result.totalUsage, {
      durationMs: Math.round(performance.now() - startedAt),
      finishReason: result.finishReason,
    });
    return normalizeAceSummary(result.text) || fallback;
  } catch (error) {
    clearTimeout(timeoutId);
    logHomepageSummaryFallback(
      HOMEPAGE_SUMMARY_CONFIG,
      Math.round(performance.now() - startedAt),
      getHomepageSummaryFailureReason(error),
    );
    return fallback;
  }
}

/* ─── Page ─────────────────────────────────────────────────────────────────── */

export default async function Home() {
  const user = await currentUser().catch(() => null);
  const userTier: PopAlphaTier = getTierLabel(user?.publicMetadata?.popalpha_tier);

  let data: Awaited<ReturnType<typeof getHomepageData>>;
  try {
    data = await Promise.race([
      getHomepageData(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), DATA_TIMEOUT_MS)),
    ]);
  } catch {
    data = { ...EMPTY_DATA };
  }

  const {
    movers,
    high_confidence_movers: highConfidenceMovers,
    emerging_movers: emergingMovers,
    losers,
    trending,
    signal_board: signalBoard,
    as_of,
    prices_refreshed_today: pricesRefreshedToday,
    tracked_cards_with_live_price: trackedCardsWithLivePrice,
  } = data;
  const asOf = timeAgo(as_of);

  let communityPulse: Awaited<ReturnType<typeof getCommunityPulseSnapshot>>;
  try {
    communityPulse = await getCommunityPulseSnapshot([...movers, ...trending, ...losers], user?.id ?? null);
  } catch {
    communityPulse = { cards: [], votesRemaining: 0, weeklyLimit: 0, weekEndsAt: 0 };
  }

  const marketNarrative = buildMarketNarrative(userTier, movers, losers, trending);
  const aceSummary = await generateAceSummary(
    movers, trending, losers,
    communityPulse.cards.map((c) => ({
      name: c.name, setName: c.setName, bullishVotes: c.bullishVotes, bearishVotes: c.bearishVotes, changePct: c.changePct,
    })),
  );
  const acePreview = splitAcePreview(aceSummary);

  // Hero showcase stays on live market movers and falls back to trending only if those rails are empty.
  const liveMarketCards = [...highConfidenceMovers, ...emergingMovers, ...movers, ...losers]
    .filter((c, i, arr) => arr.findIndex((x) => x.slug === c.slug) === i);
  const heroMarketCards = (liveMarketCards.length > 0 ? liveMarketCards : trending)
    .filter((c, i, arr) => arr.findIndex((x) => x.slug === c.slug) === i);

  const heroCards = [...heroMarketCards]
    .sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0))
    .slice(0, 5);
  const highConfidenceCount = highConfidenceMovers.length;
  const strongMoverRailCards = [...highConfidenceMovers, ...movers]
    .filter((card, index, cards) => cards.findIndex((entry) => entry.slug === card.slug) === index)
    .slice(0, 5);
  const topMoverCardsByWindow = signalBoard.top_movers;
  const biggestDropsByWindow = signalBoard.biggest_drops;
  const momentumCardsByWindow = signalBoard.momentum;
  const heroPulseCards = heroCards.slice(0, 4);
  const heroLeadingSet = getLeadingSet(heroMarketCards);
  const heroBrief = buildHeroBrief(
    aceSummary,
    heroPulseCards,
    heroLeadingSet,
    marketNarrative || "The market is still taking shape.",
  );
  const focusPills = buildFocusPills([...heroPulseCards, ...trending, ...movers], TRENDING_SET_PILLS, 2);
  const livePriceCount = formatExactCount(trackedCardsWithLivePrice);
  const refreshedCount = formatExactCount(pricesRefreshedToday);
  const heroBriefGrounding = trackedCardsWithLivePrice !== null && pricesRefreshedToday !== null
    ? `Grounded in ${livePriceCount} live prices and ${refreshedCount} refreshed cards from the last 24 hours.`
    : "Grounded in live market pricing and request-time refresh rails.";
  const heroProofStats = [
    {
      value: livePriceCount,
      label: "Coverage online",
      detail: "Canonical RAW cards with an active public market price right now.",
      accentClass: "border-[#173642] bg-[linear-gradient(180deg,rgba(15,29,36,0.9),rgba(10,18,24,0.94))]",
      dotClass: "bg-[#42D6E8]",
    },
    {
      value: refreshedCount,
      label: "Fresh in 24h",
      detail: "Cards updated inside the trailing 24-hour freshness window.",
      accentClass: "border-[#17382E] bg-[linear-gradient(180deg,rgba(14,27,22,0.9),rgba(9,18,15,0.94))]",
      dotClass: "bg-[#5CE07D]",
    },
    {
      value: asOf ? asOf : "Live now",
      label: "Latest market tick",
      detail: "Most recent timestamp currently flowing through PopAlpha's live price rails.",
      accentClass: "border-[#25303B] bg-[linear-gradient(180deg,rgba(17,22,28,0.9),rgba(11,14,18,0.94))]",
      dotClass: "bg-[#A5B4FC]",
    },
  ] as const;
  const strongMoversBadge = getChangeWindowBadge([
    ...topMoverCardsByWindow["24H"],
    ...topMoverCardsByWindow["7D"],
  ], "Live");
  const communityVoteTotals = communityPulse.cards.reduce((totals, card) => ({
    bullish: totals.bullish + card.bullishVotes,
    total: totals.total + card.bullishVotes + card.bearishVotes,
  }), { bullish: 0, total: 0 });
  const communityBullishPct = communityVoteTotals.total > 0
    ? Math.round((communityVoteTotals.bullish / communityVoteTotals.total) * 100)
    : null;
  const discoveryCards = [
    {
      eyebrow: "Daily brief",
      value: "Live market read",
      detail: heroBrief.lead,
      href: "#market-intelligence",
      linkLabel: "Read the brief",
      accentClass: "border-[#173642] bg-[linear-gradient(180deg,rgba(16,29,37,0.92),rgba(10,17,23,0.96))]",
      linkClass: "text-[#7DD3FC]",
    },
    {
      eyebrow: "Top movers",
      value: strongMoverRailCards.length > 0 ? `${strongMoverRailCards.length} names in focus` : "Signal still forming",
      detail: highConfidenceCount > 0
        ? highConfidenceCount >= strongMoverRailCards.length
          ? `${strongMoversBadge} movers are already clearing the confidence threshold.`
          : `${highConfidenceCount} high-confidence movers are leading a broader live mover board.`
        : strongMoverRailCards.length > 0
          ? "Live movers are active even while the high-confidence group is still forming."
          : "The board is still waiting for a deeper group of high-confidence breakouts.",
      href: "#top-movers",
      linkLabel: "See top movers",
      accentClass: "border-[#17382E] bg-[linear-gradient(180deg,rgba(15,28,22,0.92),rgba(10,18,15,0.96))]",
      linkClass: "text-[#5CE07D]",
    },
    {
      eyebrow: "Where the move is",
      value: heroLeadingSet.name ?? (communityBullishPct != null ? `${communityBullishPct}% bullish` : "Watching for a leader"),
      detail: heroLeadingSet.name
        ? `${heroLeadingSet.count} hero cards from this set are leading the market right now.`
        : communityBullishPct != null
          ? `Community Pulse is running ${communityBullishPct}% bullish on the live board.`
          : "Watch where prices and collector votes start lining up.",
      href: heroLeadingSet.name ? "#momentum-rail" : "#market-intelligence",
      linkLabel: heroLeadingSet.name ? "See the move" : "See community votes",
      accentClass: "border-[#25303B] bg-[linear-gradient(180deg,rgba(18,22,29,0.92),rgba(11,14,19,0.96))]",
      linkClass: "text-[#A5B4FC]",
    },
  ] as const;
  const heroStats = [
    { value: livePriceCount, label: "Live card prices", href: "/search" },
    { value: refreshedCount, label: "Refreshed 24h", href: "/data" },
    { value: asOf ? `Live ${asOf}` : "Live", label: "Last market update", href: "/data" },
    { value: "Open", label: "Public data monitor", href: "/data" },
  ] as const;

  return (
    <div className="landing-shell min-h-screen bg-[#060608] text-[#F0F0F0]">
      <SiteHeader
        showSignIn={!user}
        primaryCta={user ? { label: "Profile", href: "/profile" } : { label: "Start free", href: "/sign-up" }}
        centerSlot={(
          <Suspense fallback={<div className="h-9 w-full rounded-full bg-white/[0.04]" />}>
            <HomepageSearch size="nav" autoFocus={false} className="w-full" />
          </Suspense>
        )}
        logoPriority
      />

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden pt-16">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 left-[12%] h-[420px] w-[420px] rounded-full bg-[#00B4D8]/[0.06] blur-[130px]" />
          <div className="absolute right-[10%] top-10 h-[320px] w-[320px] rounded-full bg-[#14B8A6]/[0.05] blur-[120px]" />
        </div>

        <div className="relative mx-auto max-w-[1400px] px-5 pb-14 pt-12 sm:px-8 sm:pt-20 lg:pb-20">
          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1.2fr)_500px] lg:gap-10 xl:grid-cols-[minmax(0,1.12fr)_560px]">
            {/* Left: Headline + Proof */}
            <div className="relative z-30 isolate max-w-[780px] lg:pr-12 xl:pr-16">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/[0.03] px-3 py-1.5 text-[12px] text-[#9EB2C2]">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00DC5A] opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#00DC5A]" />
                </span>
                <span>{asOf ? `Live ${asOf}` : "Live now"}</span>
              </div>

              <h1 className="relative z-40 mt-7 text-[clamp(3.45rem,5.95vw,5rem)] font-semibold leading-[0.86] tracking-[-0.058em] text-white">
                <span className="block sm:whitespace-nowrap">{HERO_HEADLINE}</span>
                <span className="mt-1 inline-block pr-[0.08em] bg-gradient-to-r from-[#9BE7F6] via-[#36D6E7] to-[#00C7B7] bg-clip-text text-transparent sm:whitespace-nowrap">
                  {HERO_HEADLINE_ACCENT}
                </span>
              </h1>

              <p className="mt-5 max-w-lg text-[17px] leading-8 text-[#98A2AE] sm:text-[18px]">
                {HERO_SUBHEADLINE}
              </p>

              <div className="mt-7 max-w-[660px] rounded-[24px] border border-[#16303A] bg-[linear-gradient(180deg,rgba(8,16,22,0.94),rgba(7,12,18,0.98))] p-4 shadow-[0_20px_55px_rgba(0,0,0,0.28)] ring-1 ring-white/[0.04] sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">
                    Public Proof
                  </p>
                  <Link
                    href="/data"
                    className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-[12px] font-semibold text-[#E7EDF2] transition-all hover:border-white/[0.15] hover:bg-white/[0.06] hover:text-white"
                  >
                    See live coverage
                  </Link>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {heroProofStats.map((stat) => (
                    <div
                      key={stat.label}
                      className={`rounded-[18px] border px-4 py-3 ${stat.accentClass}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${stat.dotClass}`} />
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8FA0AF]">
                          {stat.label}
                        </p>
                      </div>
                      <p className="mt-3 text-[22px] font-semibold tracking-tight text-white">
                        {stat.value}
                      </p>
                      <p className="mt-2 text-[11px] leading-5 text-[#7B8793]">
                        {stat.detail}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                {discoveryCards.map((card) => (
                  <Link
                    key={card.eyebrow}
                    href={card.href}
                    className={`group rounded-[22px] border p-4 transition-all hover:border-white/[0.12] hover:bg-white/[0.03] ${card.accentClass}`}
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7F8D98]">
                      {card.eyebrow}
                    </p>
                    <p className="mt-3 text-[16px] font-semibold leading-6 tracking-tight text-white">
                      {card.value}
                    </p>
                    <p className="mt-2 text-[12px] leading-6 text-[#94A0AB]">
                      {card.detail}
                    </p>
                    <span className={`mt-4 inline-flex items-center gap-2 text-[11px] font-semibold transition-colors group-hover:text-white ${card.linkClass}`}>
                      {card.linkLabel}
                      <span aria-hidden="true">→</span>
                    </span>
                  </Link>
                ))}
              </div>

              {/* Direct Lookup */}
              <div className="mt-8 max-w-[560px] lg:hidden">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7C8792]">
                      Direct lookup
                    </p>
                    <p className="mt-1 text-[13px] text-[#8E98A3]">
                      Know the exact card? Jump straight into its live detail page.
                    </p>
                  </div>
                  <Link
                    href="/search"
                    className="text-[12px] font-semibold text-[#7DD3FC] transition-colors hover:text-white"
                  >
                    Open full search
                  </Link>
                </div>
                <div className="overflow-hidden rounded-[28px] bg-[linear-gradient(180deg,rgba(18,22,29,0.88),rgba(10,12,16,0.94))] p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.34)] ring-1 ring-white/[0.05] backdrop-blur-xl">
                  <Suspense
                    fallback={<div className="h-[60px] rounded-full bg-white/[0.03]" />}
                  >
                    <HomepageSearch />
                  </Suspense>
                </div>
                <div className="mt-4">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#68727C]">
                    Start with a live pocket
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                  {focusPills.map((name) => (
                    <Link
                      key={name}
                      href={`/search?q=${encodeURIComponent(name)}`}
                      className="rounded-full bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-[#A0A9B4] transition-all hover:bg-white/[0.07] hover:text-white"
                    >
                      {name}
                    </Link>
                  ))}
                  </div>
                </div>
              </div>

              {/* CTA Row */}
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <Link
                  href="/sign-up"
                  className="group inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-[14px] font-semibold text-[#060608] transition-all hover:shadow-[0_0_30px_rgba(255,255,255,0.12)]"
                  style={{ backgroundColor: "#ffffff" }}
                >
                  {HERO_PRIMARY_CTA}
                  <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </Link>
                <Link
                  href="#market-intelligence"
                  className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.02] px-6 py-3.5 text-[14px] font-medium text-[#D0D4DB] transition-all hover:border-white/[0.2] hover:bg-white/[0.04] hover:text-white"
                >
                  {HERO_SECONDARY_CTA}
                </Link>
              </div>
            </div>

            {/* Right: Product Composition */}
            <div className="relative z-0 w-full max-w-[600px] lg:justify-self-end lg:pt-10">
              <div className="pointer-events-none absolute left-4 top-2 h-[280px] w-[280px] rounded-full bg-[#2FD0E3]/[0.15] blur-[120px]" />
              <div className="pointer-events-none absolute bottom-6 right-8 h-[220px] w-[220px] rounded-full bg-[#0F766E]/[0.1] blur-[110px]" />

              <div className="relative z-20 max-w-[540px] overflow-hidden rounded-[34px] bg-[linear-gradient(145deg,rgba(20,32,42,0.98),rgba(8,13,18,0.98)_72%)] px-6 py-6 shadow-[0_34px_90px_rgba(0,0,0,0.48)] ring-1 ring-white/[0.08] backdrop-blur-2xl sm:px-7 sm:py-7">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(84,216,232,0.12),transparent)]" />
                <div className="relative">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <Image
                        src="/brand/popalpha-icon-transparent.svg"
                        alt="PopAlpha logo"
                        width={48}
                        height={48}
                        className="h-12 w-12 shrink-0"
                      />
                      <div>
                        <span className="text-[12px] font-medium text-[#98E7F3]">PopAlpha AI Summary</span>
                      </div>
                    </div>
                    <span className="text-[11px] text-[#8D97A2]">
                      {asOf ? `Updated ${asOf}` : "Live"}
                    </span>
                  </div>

                  <div className="mt-6 rounded-xl border border-white/[0.04] bg-white/[0.02] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-[#5F6A76]">Today&apos;s Read</span>
                      <Link
                        href="/data"
                        className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7DD3FC] transition-colors hover:text-white"
                      >
                        Proof
                      </Link>
                    </div>
                    <p className="mt-2 text-[15px] font-medium leading-relaxed text-[#D4DCE4]">
                      {heroBrief.lead}
                    </p>
                    {heroBrief.secondary ? (
                      <p className="mt-3 text-[14px] leading-relaxed text-[#94A0AB]">
                        {heroBrief.secondary}
                      </p>
                    ) : null}
                    <p className="mt-4 text-[12px] leading-relaxed text-[#7B8793]">
                      {heroBriefGrounding}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trust Strip ─────────────────────────────────────────────────── */}
      <section className="border-y border-white/[0.04] bg-[#07090D]">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
          <div className="grid gap-y-6 py-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-y-0">
            {heroStats.map((stat, index) => (
              <Link
                key={stat.label}
                href={stat.href}
                className={`${index > 0 ? "lg:border-l lg:border-white/[0.05] lg:pl-6" : ""} ${index < heroStats.length - 1 ? "lg:pr-6" : ""}`}
              >
                <span className="text-[16px] font-semibold tracking-tight text-white transition-colors hover:text-[#9BE7F6] sm:text-[18px]">{stat.value}</span>
                <p className="mt-1 text-[12px] text-[#6D7783]">{stat.label}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <HomepageSignalBoard
        topMoversByWindow={topMoverCardsByWindow}
        biggestDropsByWindow={biggestDropsByWindow}
        momentumByWindow={momentumCardsByWindow}
      />

      {/* ── Market Intelligence ─────────────────────────────────────────── */}
      <section id="market-intelligence" className="border-t border-white/[0.04] bg-[#08080C] py-16 sm:py-24">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
          <div className="grid gap-8 lg:grid-cols-2">
            {/* Scout Brief */}
            <div className="relative overflow-hidden rounded-2xl border border-[#00B4D8]/10 bg-gradient-to-br from-[#0C1015] to-[#0A0A0E] p-6 sm:p-8">
              <div className="pointer-events-none absolute -right-20 -top-20 h-40 w-40 rounded-full bg-[#00B4D8]/[0.04] blur-[60px]" />

              <div className="relative">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#00B4D8]/10 text-[16px]">
                      🔮
                    </div>
                    <div>
                      <span className="text-[15px] font-bold text-white">PopAlpha Scout</span>
                      <p className="text-[11px] font-medium text-[#00B4D8]">Live market brief</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF3B30] opacity-60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-[#FF3B30]" />
                    </span>
                    <span className="text-[11px] font-semibold text-[#FF6B6B]">LIVE</span>
                  </div>
                </div>

                <div className="mt-5 rounded-xl border border-white/[0.04] bg-white/[0.02] p-4">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-[#555]">Today&apos;s Read</span>
                  <p className="mt-1.5 text-[15px] font-medium leading-relaxed text-[#D4D4D8]">
                    {heroCards[0] ? `${heroCards[0].name} is setting the pace today at ${formatPct(heroCards[0].change_pct)}.` : "The market is still taking shape."}
                  </p>
                </div>

                <div className="mt-4">
                  <TypewriterText
                    text={HOMEPAGE_SCOUT_NARRATIVE}
                    className="text-[14px] leading-relaxed text-[#888]"
                  />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {["Few cards moving", "Votes climbing", "Chase cards leading"].map((tag) => (
                    <span key={tag} className="rounded-full border border-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-[#666]">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Ace Intelligence Preview */}
            <div className="relative overflow-hidden rounded-2xl border border-[#7C3AED]/10 bg-gradient-to-br from-[#0E0C15] to-[#0A0A0E] p-6 sm:p-8">
              <div className="pointer-events-none absolute -right-20 -top-20 h-40 w-40 rounded-full bg-[#7C3AED]/[0.04] blur-[60px]" />

              <div className="relative">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#7C3AED]/10 text-[16px]">
                      ⚡
                    </div>
                    <div>
                      <span className="text-[15px] font-bold text-white">PopAlpha Ace</span>
                      <p className="text-[11px] font-medium text-[#7C3AED]">Deeper market read</p>
                    </div>
                  </div>
                  <span className="rounded-md bg-[#FFD700]/10 px-2 py-0.5 text-[10px] font-bold text-[#FFD700]">PRO</span>
                </div>

                <div className="mt-5">
                  <p className="text-[14px] leading-relaxed text-[#999]">
                    {acePreview.lead}
                  </p>
                  {acePreview.remainder && (
                    <div className="relative mt-3 overflow-hidden rounded-xl">
                      <p className="text-[14px] leading-relaxed text-[#999] blur-[4px] select-none">
                        {acePreview.remainder}
                      </p>
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[#0E0C15] to-transparent" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="rounded-full bg-gradient-to-r from-[#7C3AED] to-[#6366F1] px-4 py-2 text-[12px] font-bold text-white shadow-[0_8px_20px_rgba(124,58,237,0.3)]">
                          Unlock Ace
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-4 rounded-xl border border-white/[0.04] bg-white/[0.02] p-3">
                  <p className="text-[12px] text-[#666]">
                    Ace goes deeper. It tells you how many cards are moving, which sets are leading, where collector votes line up, and which moves look risky. Updated live.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Collector Edge Section ───────────────────────────────────────── */}
      <section className="border-t border-white/[0.04] py-16 sm:py-24">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
          <div className="text-center">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#00B4D8]">The Collector&apos;s Edge</span>
            <h2 className="mt-3 text-[clamp(1.5rem,3vw,2.5rem)] font-bold tracking-tight text-white">
              Beyond price: see why a card is moving and what to watch next
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-[#666]">
              PopAlpha combines live pricing, confidence reads, what's moving, and an AI market brief — built for Pokémon collectors, not Wall Street analysts.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: "🔍",
                title: "Instant market context",
                desc: "Search or scan any card to see price, market strength, and recent market context in seconds.",
                accent: "#00B4D8",
              },
              {
                icon: "🤖",
                title: "AI market briefs",
                desc: "Daily reads on what is moving, why it matters, and what to watch next.",
                accent: "#7C3AED",
              },
              {
                icon: "📊",
                title: "Confidence scoring",
                desc: "Every move is scored so you can separate real traction from noisy prints.",
                accent: "#00DC5A",
              },
              {
                icon: "💼",
                title: "Portfolio intelligence",
                desc: "Track value, monitor strength shifts, and follow raw, sealed, and graded exposure.",
                accent: "#FFD700",
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="group rounded-2xl border border-white/[0.06] bg-[#0C0C10] p-6 transition-all hover:border-white/[0.1] hover:shadow-[0_0_30px_rgba(0,0,0,0.3)]"
              >
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-[18px]"
                  style={{ background: `${feature.accent}10` }}
                >
                  {feature.icon}
                </div>
                <h3 className="mt-4 text-[15px] font-bold text-white">{feature.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-[#666]">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Workflow Section ─────────────────────────────────────────────── */}
      <section className="border-t border-white/[0.04] bg-[#08080C] py-16 sm:py-24">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
          <div className="text-center">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#00DC5A]">How It Works</span>
            <h2 className="mt-3 text-[clamp(1.5rem,3vw,2.25rem)] font-bold tracking-tight text-white">
              From discovery to decision in seconds
            </h2>
          </div>

          <div className="mx-auto mt-12 grid max-w-4xl gap-6 sm:grid-cols-3">
            {[
              {
                step: "01",
                title: "Search or scan",
                desc: "Type a card name, paste a URL, or scan with your camera. Live results in seconds.",
                accent: "#00B4D8",
              },
              {
                step: "02",
                title: "Read the market",
                desc: "See price action, confidence score, market strength, and AI context in one view.",
                accent: "#7C3AED",
              },
              {
                step: "03",
                title: "Track and act",
                desc: "Save key names to your watchlist or portfolio and act when strength builds or fades.",
                accent: "#00DC5A",
              },
            ].map((item, i) => (
              <div key={item.step} className="relative">
                {i < 2 && (
                  <div className="pointer-events-none absolute right-0 top-8 hidden h-px w-6 bg-gradient-to-r from-white/10 to-transparent sm:block" style={{ right: "-12px" }} />
                )}
                <div className="rounded-2xl border border-white/[0.06] bg-[#0C0C10] p-6">
                  <span
                    className="text-[32px] font-bold tabular-nums"
                    style={{ color: item.accent, opacity: 0.3 }}
                  >
                    {item.step}
                  </span>
                  <h3 className="mt-3 text-[16px] font-bold text-white">{item.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-[#666]">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Why PopAlpha ─────────────────────────────────────────────────── */}
      <section className="border-t border-white/[0.04] py-16 sm:py-24">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
          <div className="text-center">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#FFD700]">Why Market Strength Beats Raw Price</span>
            <h2 className="mt-3 text-[clamp(1.5rem,3vw,2.25rem)] font-bold tracking-tight text-white">
              Price tells you what happened. Market strength shows how real the move is.
            </h2>
          </div>

          <div className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-3">
            {[
              {
                label: "Price Trackers",
                items: ["Last-sale pricing", "Historical charts", "Basic search"],
                accent: "#555",
                muted: true,
              },
              {
                label: "Marketplaces",
                items: ["Listings and recent sales", "Seller and transaction detail", "Built to transact, not interpret"],
                accent: "#555",
                muted: true,
              },
              {
                label: "PopAlpha",
                items: [
                  "Price + confidence + market strength",
                  "AI market briefs",
                  "Tracks what is moving and where votes line up",
                  "Portfolio and watchlist tools",
                  "Raw, sealed, and graded coverage",
                ],
                accent: "#00B4D8",
                muted: false,
              },
            ].map((col) => (
              <div
                key={col.label}
                className={`rounded-2xl border p-6 ${col.muted ? "border-white/[0.04] bg-[#0A0A0E]" : "border-[#00B4D8]/20 bg-[#00B4D8]/[0.03] shadow-[0_0_30px_rgba(0,180,216,0.06)]"}`}
              >
                <span
                  className={`text-[12px] font-bold uppercase tracking-widest ${col.muted ? "text-[#555]" : "text-[#00B4D8]"}`}
                >
                  {col.label}
                </span>
                <ul className="mt-4 space-y-2.5">
                  {col.items.map((item) => (
                    <li key={item} className="flex items-start gap-2">
                      <span className={`mt-1 text-[12px] ${col.muted ? "text-[#444]" : "text-[#00B4D8]"}`}>
                        {col.muted ? "–" : "✓"}
                      </span>
                      <span className={`text-[13px] ${col.muted ? "text-[#555]" : "text-[#ccc]"}`}>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-t border-white/[0.04] py-20 sm:py-32">
        {/* Ambient glow */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#00B4D8]/[0.04] blur-[120px]" />
          <div className="absolute left-1/3 top-1/3 h-[300px] w-[300px] rounded-full bg-[#7C3AED]/[0.03] blur-[80px]" />
        </div>

        <div className="relative mx-auto max-w-2xl px-5 text-center sm:px-8">
          <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-bold leading-[1.1] tracking-tight text-white">
            Start tracking with the
            <br />
            <span className="bg-gradient-to-r from-[#00B4D8] to-[#00DC5A] bg-clip-text text-transparent">full picture</span>
          </h2>
          <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-[#666]">
            Search free, scan any card, and explore the live market. Upgrade for AI briefs, market strength, and portfolio tools.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/sign-up"
              className="group inline-flex items-center gap-2 rounded-full px-8 py-3.5 text-[15px] font-semibold text-[#060608] transition-all hover:shadow-[0_0_40px_rgba(255,255,255,0.15)]"
              style={{ backgroundColor: "#ffffff" }}
            >
              {HERO_PRIMARY_CTA}
              <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>
            <Link
              href="/search"
              className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] px-8 py-3.5 text-[15px] font-medium text-[#ccc] transition-all hover:border-white/[0.2] hover:text-white"
            >
              {HERO_SECONDARY_CTA}
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.04] bg-[#060608] py-10">
        <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-4 px-5 sm:flex-row sm:px-8">
          <span className="text-[13px] font-medium text-[#444]">PopAlpha</span>
          <div className="flex items-center gap-5">
            {["About", "Sets", "Portfolio"].map((item) => (
              <Link
                key={item}
                href={`/${item.toLowerCase()}`}
                className="text-[12px] font-medium text-[#555] transition-colors hover:text-white"
              >
                {item}
              </Link>
            ))}
          </div>
          <span className="text-[11px] text-[#333]">Collector intelligence, not financial advice.</span>
        </div>
      </footer>
    </div>
  );
}

/* ─── Sub-components ───────────────────────────────────────────────────────── */
