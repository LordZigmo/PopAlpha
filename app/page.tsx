import { Suspense } from "react";
import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { getHomepageData, type HomepageCard } from "@/lib/data/homepage";
import { getCommunityPulseSnapshot } from "@/lib/data/community-pulse";
import { getPopAlphaModel } from "@/lib/ai/models";
import HomepageSearch from "@/components/homepage-search";
import TypewriterText from "@/components/typewriter-text";

export const dynamic = "force-dynamic";

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

function formatPrice(n: number | null): string {
  if (n == null || n <= 0) return "--";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(n: number | null): string {
  if (n == null) return "--";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatMarketStrength(score: number | null): string {
  if (score == null || !Number.isFinite(score)) return "--";
  return `${Math.round(score)}`;
}

function formatCount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function getDirectionMeta(direction: HomepageCard["market_direction"]) {
  if (direction === "bullish") {
    return {
      label: "Bullish",
      textClass: "text-[#00DC5A]",
    };
  }
  if (direction === "bearish") {
    return {
      label: "Bearish",
      textClass: "text-[#FF6B6B]",
    };
  }
  if (direction === "flat") {
    return {
      label: "Flat",
      textClass: "text-[#D1D5DB]",
    };
  }
  return null;
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
  as_of: string | null;
  prices_refreshed_today: number | null;
  tracked_cards_with_live_price: number | null;
} = {
  movers: [],
  high_confidence_movers: [],
  emerging_movers: [],
  losers: [],
  trending: [],
  as_of: null,
  prices_refreshed_today: null,
  tracked_cards_with_live_price: null,
};
const DATA_TIMEOUT_MS = 8_000;
const AI_TIMEOUT_MS = 4_000;

const TRENDING_SET_PILLS = [
  "Prismatic Evolutions",
  "151",
  "Evolving Skies",
  "Crown Zenith",
  "Paldean Fates",
] as const;

const HERO_HEADLINE = "Market Intelligence";
const HERO_HEADLINE_ACCENT = "for Pokemon Collectors";
const HERO_SUBHEADLINE =
  "Live pricing, market strength, and PopAlpha AI briefs that show what is moving, why it is moving, and what deserves your attention.";
const HERO_PRIMARY_CTA = "Start free";
const HERO_SECONDARY_CTA = "Explore live market";
const HOMEPAGE_SCOUT_NARRATIVE =
  "The market still looks selective today. A few chase cards are leading, but the move has not spread across the whole board. The next thing to watch is whether strength moves into deeper cards and sealed.";

type PopAlphaTier = "Trainer" | "Ace" | "Elite";

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

function buildAceNarrativeFallback(
  movers: HomepageCard[],
  trending: HomepageCard[],
  losers: HomepageCard[],
  communityCards: Array<{
    name: string;
    setName: string | null;
    bullishVotes: number;
    bearishVotes: number;
    changePct: number | null;
  }>,
): string {
  const leader = movers[0];
  const trend = trending[0];
  const laggard = losers[0];
  const communityLeader = communityCards[0];
  const communityTotal = communityLeader ? communityLeader.bullishVotes + communityLeader.bearishVotes : 0;
  const communityPct = communityLeader && communityTotal > 0
    ? Math.round((communityLeader.bullishVotes / communityTotal) * 100)
    : null;

  if (leader && trend && laggard) {
    return `${leader.name} is leading right now, and ${trend.set_name ?? trend.name} is helping keep that move alive. ${laggard.name} is weaker, so this still looks selective, not broad.\n\n${communityLeader ? `${communityLeader.name} is also getting about ${communityPct ?? 50}% bullish votes in Community Pulse.` : "Community Pulse will show if the crowd agrees."} If those votes keep lining up with price strength, conviction is getting stronger.`;
  }
  if (leader) {
    return `${leader.name} is the clearest leader right now. The rest of the market still does not look too hot.\n\n${communityLeader ? `Community Pulse is also leaning toward ${communityLeader.name}.` : "Next, watch if the crowd keeps backing the same leader."} If price strength and collector interest stay together, the move is more likely to hold.`;
  }
  if (trend) {
    return `${trend.set_name ?? trend.name} is getting a lot of attention, but the board still does not feel crowded. The market is still picking its leaders.\n\n${communityLeader ? `${communityLeader.name} is also picking up community votes.` : "Next, watch if that attention turns into stronger prices."} If it does, one pocket of the market could pull ahead fast.`;
  }
  return "The board is still taking shape. The strongest action is still narrow, so the next clear leader has not fully broken out yet.\n\nCommunity Pulse still matters because it can show where real conviction starts first. Watch for cards that keep holding attention, price, and repeat votes at the same time.";
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

function buildHeroBriefBullets(
  pulseCards: HomepageCard[],
  leaderSet: { name: string | null; count: number },
  strongMoverCards: HomepageCard[],
): string[] {
  if (pulseCards.length === 0) {
    return [
      "Fresh movers surface here as live prices refresh.",
      "Market strength stays muted until real follow-through appears.",
      "PopAlpha AI updates the read as leadership changes.",
    ];
  }

  const bullets: string[] = [];

  if (leaderSet.name && leaderSet.count >= 2) {
    bullets.push(`${leaderSet.count} cards in ${leaderSet.name} are outperforming in the live pulse`);
  } else if (pulseCards[0]?.set_name) {
    bullets.push(`${pulseCards[0].set_name} is still setting the tone for the live board`);
  }

  const strongScoreCount = pulseCards.filter((card) => (card.market_strength_score ?? 0) >= 60).length;
  const averageStrength = averageValues(pulseCards.map((card) => card.market_strength_score));
  if (strongScoreCount >= 2) {
    bullets.push(`${strongScoreCount} lead names are clearing a 60+ market-strength score`);
  } else if (averageStrength !== null) {
    bullets.push(`Signal quality is averaging ${averageStrength}/100 across the lead names`);
  } else if (strongMoverCards.length > 0) {
    bullets.push(`${strongMoverCards.length} movers are still holding leadership as fresh prices refresh`);
  }

  const positiveCount = pulseCards.filter((card) => (card.change_pct ?? 0) > 0).length;
  if (positiveCount >= 3) {
    bullets.push("Move looks broad enough to watch as real set-level momentum");
  } else {
    bullets.push("Breadth is still selective, so follow-through matters more than one-card spikes");
  }

  return bullets.slice(0, 3);
}

async function generateAceSummary(
  movers: HomepageCard[],
  trending: HomepageCard[],
  losers: HomepageCard[],
  communityCards: Array<{
    name: string;
    setName: string | null;
    bullishVotes: number;
    bearishVotes: number;
    changePct: number | null;
  }>,
): Promise<string> {
  const fallback = buildAceNarrativeFallback(movers, trending, losers, communityCards);
  const topContext = [
    ...movers.slice(0, 2).map((c, i) =>
      `Top mover ${i + 1}: ${c.name} (${c.set_name ?? "Unknown"}) at ${c.market_price != null ? `$${c.market_price}` : "unknown"} with ${c.change_pct != null ? `${c.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...trending.slice(0, 2).map((c, i) =>
      `Trending ${i + 1}: ${c.name} (${c.set_name ?? "Unknown"}) at ${c.market_price != null ? `$${c.market_price}` : "unknown"} with ${c.change_pct != null ? `${c.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...losers.slice(0, 1).map((c) =>
      `Biggest drop: ${c.name} (${c.set_name ?? "Unknown"}) with ${c.change_pct != null ? `${c.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...communityCards.slice(0, 3).map((c, i) => {
      const total = c.bullishVotes + c.bearishVotes;
      const pct = total > 0 ? Math.round((c.bullishVotes / total) * 100) : 50;
      return `Community pulse ${i + 1}: ${c.name} (${c.setName ?? "Unknown"}) has ${pct}% bullish across ${total} votes.`;
    }),
  ].join("\n");

  try {
    const result = await Promise.race([
      generateText({
        model: getPopAlphaModel("Ace"),
        system: [
          "You are PopAlpha Ace Summary, a premium market note for the homepage.",
          "Write in plain English at about an 8th-grade reading level.",
          "Use short sentences and common words.",
          "Sound calm, sharp, and useful.",
          "Avoid hype, slang, and heavy finance jargon.",
          "Use the supplied price, trend, loser, and community vote signals.",
          "Write exactly 2 short paragraphs.",
          "Use no more than 2 sentences per paragraph.",
          "Paragraph 1 should say what part of the market looks strongest.",
          "Paragraph 2 should say whether community votes support the move and what to watch next.",
          "Do not mention being an AI, and do not invent metrics.",
        ].join(" "),
        prompt: [
          "Summarize the market using only the supplied homepage and community pulse data.",
          "Call out the strongest pocket of momentum.",
          "Say whether the crowd is backing that move or lagging it.",
          "Keep the read short, clear, and useful.",
          "",
          topContext,
        ].join("\n"),
      }),
      new Promise<{ text: string }>((resolve) =>
        setTimeout(() => resolve({ text: fallback }), AI_TIMEOUT_MS),
      ),
    ]);
    return normalizeAceSummary(result.text) || fallback;
  } catch {
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

  // Featured card prefers a real mover with a scored market-strength read.
  const positiveHeroCards = [...heroMarketCards]
    .filter((card) => (card.change_pct ?? 0) > 0)
    .sort((left, right) => (right.change_pct ?? 0) - (left.change_pct ?? 0));
  const topGainer = positiveHeroCards.find((card) => card.market_strength_score !== null)
    ?? positiveHeroCards[0]
    ?? heroMarketCards.find((card) => card.market_strength_score !== null)
    ?? heroMarketCards[0]
    ?? null;
  const featuredCard = topGainer;

  // Hero panel cards only show the rest of the live market set.
  const heroCards = heroMarketCards
    .filter((c) => c.slug !== featuredCard?.slug)
    .sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0))
    .slice(0, 5);
  const strongMoverCards = (highConfidenceMovers.length > 0 ? highConfidenceMovers : movers)
    .filter((card) => card.slug !== featuredCard?.slug)
    .slice(0, 4);
  const heroPulseCards = (featuredCard ? [featuredCard, ...heroCards] : heroCards)
    .filter((card, index, cards) => cards.findIndex((entry) => entry.slug === card.slug) === index)
    .slice(0, 4);
  const heroAverageStrength = averageValues(heroPulseCards.map((card) => card.market_strength_score));
  const heroLeadingSet = getLeadingSet(heroMarketCards);
  const heroBriefLead =
    acePreview.lead
    || marketNarrative
    || "The live board is still taking shape, but PopAlpha is already separating real momentum from noise.";
  const heroBriefBullets = buildHeroBriefBullets(heroPulseCards, heroLeadingSet, strongMoverCards);
  const focusPills = buildFocusPills([...heroPulseCards, ...trending, ...movers], TRENDING_SET_PILLS);
  const heroStats = [
    { value: formatCount(trackedCardsWithLivePrice), label: "Live prices tracked" },
    { value: formatCount(pricesRefreshedToday), label: "Cards refreshed today" },
    { value: "Raw • Sealed • Graded", label: "Coverage" },
    { value: "Live", label: "AI briefs generated" },
    { value: heroAverageStrength != null ? `${heroAverageStrength}/100` : "Scored live", label: "Signal quality scored" },
  ] as const;

  const trendingCards = trending.slice(0, 5);
  const dropCards = losers.slice(0, 5);
  const strongMoversBadge = getChangeWindowBadge(strongMoverCards.length > 0 ? strongMoverCards : movers, "Live");
  const pullbacksBadge = getChangeWindowBadge(dropCards, "Live");

  return (
    <div className="landing-shell min-h-screen bg-[#060608] text-[#F0F0F0]">
      {/* ── Navbar ──────────────────────────────────────────────────────── */}
      <nav className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-[#060608]/80 backdrop-blur-2xl">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="text-lg font-bold tracking-tight text-white">PopAlpha</span>
            </Link>
            <div className="hidden items-center gap-1 md:flex">
              {["Explore", "Market", "Sets", "Portfolio", "Briefs"].map((item) => (
                <Link
                  key={item}
                  href={item === "Explore" ? "/search" : item === "Market" ? "/" : item === "Sets" ? "/sets" : item === "Portfolio" ? "/portfolio" : "/about"}
                  className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-[#8A8A8E] transition-colors hover:bg-white/[0.04] hover:text-white"
                >
                  {item}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/sign-in"
              className="hidden rounded-lg px-3 py-1.5 text-[13px] font-medium text-[#8A8A8E] transition-colors hover:text-white sm:block"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="rounded-full bg-[#00B4D8] px-4 py-2 text-[13px] font-semibold text-[#060608] transition-all hover:bg-[#00C9F0] hover:shadow-[0_0_20px_rgba(0,180,216,0.3)]"
            >
              Start free
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden pt-16">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-28 left-[12%] h-[460px] w-[460px] rounded-full bg-[#00B4D8]/[0.08] blur-[120px]" />
          <div className="absolute right-[10%] top-10 h-[360px] w-[360px] rounded-full bg-[#14B8A6]/[0.08] blur-[110px]" />
          <div className="absolute inset-x-0 top-0 h-40 bg-[linear-gradient(180deg,rgba(0,180,216,0.06),transparent)]" />
        </div>

        <div className="relative mx-auto max-w-[1400px] px-5 pb-14 pt-12 sm:px-8 sm:pt-20 lg:pb-20">
          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_560px] lg:gap-16 xl:grid-cols-[minmax(0,1fr)_600px]">
            {/* Left: Headline + Search */}
            <div className="max-w-[640px]">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#00B4D8]/15 bg-[#07161B]/90 px-3.5 py-1.5 shadow-[0_14px_40px_rgba(0,0,0,0.25)]">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00DC5A] opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#00DC5A]" />
                </span>
                <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#7ADCEC]">
                  {asOf ? `Market data refreshed ${asOf}` : "Market data refreshed live"}
                </span>
              </div>

              <h1 className="mt-7 text-[clamp(2.75rem,5vw,4.35rem)] font-semibold leading-[0.98] tracking-[-0.05em] text-white">
                {HERO_HEADLINE}
                <br />
                <span className="bg-gradient-to-r from-[#9BE7F6] via-[#36D6E7] to-[#00C7B7] bg-clip-text text-transparent">
                  {HERO_HEADLINE_ACCENT}
                </span>
              </h1>

              <p className="mt-6 max-w-xl text-[17px] leading-8 text-[#9AA3AE] sm:text-[18px]">
                {HERO_SUBHEADLINE}
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-[#B7C0CB]">
                {["Live pricing", "Signal quality", "PopAlpha AI briefs"].map((item) => (
                  <span key={item} className="inline-flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#48D8E7]" />
                    {item}
                  </span>
                ))}
              </div>

              {/* Search Bar */}
              <div className="mt-9 max-w-[560px]">
                <div className="mb-3 flex items-center justify-between gap-3 px-1 text-[11px] font-medium uppercase tracking-[0.18em] text-[#697381]">
                  <span>Search the live market</span>
                  <span className="hidden sm:inline">Press / to focus</span>
                </div>
                <div className="overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(18,22,29,0.96),rgba(10,12,16,0.98))] p-1.5 shadow-[0_24px_70px_rgba(0,0,0,0.45)] backdrop-blur-xl">
                  <Suspense
                    fallback={<div className="h-[60px] rounded-full bg-white/[0.03]" />}
                  >
                    <HomepageSearch />
                  </Suspense>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2.5">
                  <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.18em] text-[#697381]">In focus</span>
                  {focusPills.map((name) => (
                    <Link
                      key={name}
                      href={`/search?q=${encodeURIComponent(name)}`}
                      className="rounded-full border border-white/[0.06] bg-white/[0.03] px-3.5 py-1.5 text-[12px] font-medium text-[#A1AAB5] transition-all hover:border-[#36D6E7]/35 hover:bg-white/[0.05] hover:text-white"
                    >
                      {name}
                    </Link>
                  ))}
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
                  href="/search"
                  className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.02] px-6 py-3.5 text-[14px] font-medium text-[#D0D4DB] transition-all hover:border-white/[0.2] hover:bg-white/[0.04] hover:text-white"
                >
                  {HERO_SECONDARY_CTA}
                </Link>
              </div>
            </div>

            {/* Right: Product Composition */}
            <div className="relative w-full max-w-[620px] lg:justify-self-end">
              <div className="pointer-events-none absolute inset-0 rounded-[36px] bg-[radial-gradient(circle_at_top,rgba(0,180,216,0.14),transparent_44%)] blur-2xl" />

              <div className="relative overflow-hidden rounded-[32px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(14,18,24,0.96),rgba(7,9,13,0.98))] p-4 shadow-[0_30px_90px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:p-5">
                <div className="pointer-events-none absolute inset-x-10 top-0 h-20 bg-[linear-gradient(180deg,rgba(93,221,239,0.08),transparent)]" />

                <div className="relative space-y-4">
                  <div className="rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[#09222A] text-[#63E2F0]">
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2 12h4l3-9 4 18 3-9h4" />
                          </svg>
                        </div>
                        <div>
                          <span className="text-[14px] font-semibold tracking-tight text-white">Market Pulse</span>
                          <p className="text-[12px] text-[#798290]">Live leaders on the board right now</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 rounded-full bg-[#0C1B19] px-3 py-1 text-[11px] font-medium text-[#66E28E]">
                        <span className="h-2 w-2 rounded-full bg-[#00DC5A]" />
                        Live
                      </div>
                    </div>

                    <div className="mt-5 space-y-1.5">
                      {heroPulseCards.map((card, index) => (
                        <Link
                          key={card.slug}
                          href={`/c/${encodeURIComponent(card.slug)}`}
                          className="group flex items-center gap-3 rounded-2xl px-2 py-2.5 transition-colors hover:bg-white/[0.04]"
                        >
                          <span className="w-5 shrink-0 text-center text-[11px] font-medium tabular-nums text-[#5C6570]">
                            {index + 1}
                          </span>
                          {card.image_url ? (
                            <img
                              src={card.image_url}
                              alt=""
                              className="h-14 w-10 rounded-[10px] object-cover shadow-[0_10px_24px_rgba(0,0,0,0.35)] transition-transform duration-200 group-hover:scale-[1.03]"
                            />
                          ) : (
                            <div className="h-14 w-10 rounded-[10px] bg-gradient-to-b from-[#1A2230] to-[#0A0E15] shadow-[0_10px_24px_rgba(0,0,0,0.35)]" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-[13px] font-semibold text-[#F2F5F7] group-hover:text-white">{card.name}</p>
                              {card.mover_tier === "hot" ? (
                                <span className="rounded-full bg-[#3A1C14] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-[#FF9B6B]">
                                  Hot
                                </span>
                              ) : null}
                            </div>
                            <p className="truncate text-[11px] text-[#6E7784]">{card.set_name ?? "Live market"}</p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-[13px] font-semibold tabular-nums text-white">{formatPrice(card.market_price)}</p>
                            <p className={`mt-1 text-[12px] font-semibold tabular-nums ${(card.change_pct ?? 0) >= 0 ? "text-[#5CE07D]" : "text-[#FF7E78]"}`}>
                              {formatPct(card.change_pct)}
                            </p>
                          </div>
                        </Link>
                      ))}
                      {heroPulseCards.length === 0 && (
                        <div className="flex min-h-28 items-center justify-center rounded-2xl border border-white/[0.05] bg-white/[0.02] px-4 text-center text-[13px] text-[#707A86]">
                          Live movers will appear here as fresh price action clears the confidence threshold.
                        </div>
                      )}
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/[0.05] bg-[#0E1218] px-4 py-3.5">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-[#66707C]">Signal quality</p>
                          <p className="mt-1 text-[13px] leading-6 text-[#B4BDC8]">
                            {heroAverageStrength != null
                              ? `Average market strength is ${heroAverageStrength}/100 across the current leaders.`
                              : "Market strength will surface here as cards build enough conviction."}
                          </p>
                        </div>
                        {heroAverageStrength != null ? (
                          <div className="w-20 shrink-0">
                            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-[#36D6E7] to-[#00D4AA]"
                                style={{ width: `${Math.max(10, Math.min(100, heroAverageStrength))}%` }}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[24px] border border-[#1F5660]/45 bg-[linear-gradient(180deg,rgba(7,26,31,0.95),rgba(10,13,19,0.98))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#79DDEC]">PopAlpha AI Brief</span>
                        <p className="mt-1 text-[12px] text-[#84909B]">Interpretation layer for the live market</p>
                      </div>
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-[#C2CBD5]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#48D8E7]" />
                        {asOf ? `Updated ${asOf}` : "Live read"}
                      </div>
                    </div>

                    <p className="mt-5 max-w-[32rem] text-[16px] font-medium leading-7 text-[#EDF3F7] sm:text-[17px]">
                      {heroBriefLead}
                    </p>

                    <ul className="mt-4 space-y-3">
                      {heroBriefBullets.map((bullet) => (
                        <li key={bullet} className="flex items-start gap-3 text-[13px] leading-6 text-[#B8C3CE]">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#48D8E7]" />
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-5 border-t border-white/[0.06] pt-4 text-[12px] text-[#82909C]">
                      Built from live pricing, market-strength scoring, and breadth across the active board.
                    </div>
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
          <div className="py-5 sm:py-6">
            <div className="overflow-hidden rounded-[24px] border border-white/[0.05] bg-[#0B0E13]">
              <div className="grid gap-px bg-white/[0.04] sm:grid-cols-2 lg:grid-cols-5">
                {heroStats.map((stat) => (
                  <div key={stat.label} className="bg-[#0B0E13] px-5 py-5 sm:px-6">
                    <span className="text-[16px] font-semibold tracking-tight text-white sm:text-[18px]">{stat.value}</span>
                    <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.16em] text-[#65707C]">{stat.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Featured Movers ─────────────────────────────────────────────── */}
      <section className="relative py-16 sm:py-24">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
          <div className="flex items-end justify-between">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#00B4D8]">Live Market</span>
              <h2 className="mt-2 text-[clamp(1.5rem,3vw,2.25rem)] font-bold tracking-tight text-white">
                What&apos;s moving with conviction
              </h2>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              {["24H", "7D"].map((period) => (
                <span
                  key={period}
                  className={`cursor-default rounded-lg px-3 py-1.5 text-[12px] font-semibold ${period === "24H" ? "bg-white/[0.08] text-white" : "text-[#555] hover:text-[#888]"}`}
                >
                  {period}
                </span>
              ))}
            </div>
          </div>

          {/* Featured card spotlight + grid */}
          <div className="mt-8 grid gap-6 lg:grid-cols-[380px_1fr] xl:grid-cols-[420px_1fr]">
            {/* Spotlight Card */}
            {featuredCard && (
              <Link
                href={`/c/${encodeURIComponent(featuredCard.slug)}`}
                className="group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#101018] to-[#0A0A0E] p-5 transition-all hover:border-[#00B4D8]/25 hover:shadow-[0_0_60px_rgba(0,180,216,0.1)] sm:p-6"
              >
                {/* Multi-layer ambient glow behind card */}
                <div className="pointer-events-none absolute left-1/2 top-8 h-[320px] w-[260px] -translate-x-1/2 rounded-full bg-[#00B4D8]/[0.06] blur-[80px] transition-opacity group-hover:opacity-100 opacity-70" />
                <div className="pointer-events-none absolute left-1/2 top-20 h-[200px] w-[180px] -translate-x-1/2 rounded-full bg-[#7C3AED]/[0.04] blur-[60px]" />

                {/* Top badge row */}
                <div className="relative mb-4 flex items-center justify-between">
                  <span className="rounded-md bg-[#00DC5A]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#00DC5A]">
                    Top Gainer
                  </span>
                  {featuredCard.mover_tier === "hot" && (
                    <span className="rounded-md bg-[#FF6B35]/10 px-2.5 py-1 text-[10px] font-bold text-[#FF6B35]">HOT</span>
                  )}
                </div>

                <div className="relative flex flex-col items-center">
                  {/* Card image with premium framing */}
                  <div className="relative">
                    {featuredCard.image_url ? (
                      <img
                        src={featuredCard.image_url}
                        alt={featuredCard.name}
                        className="relative z-10 h-[300px] w-auto rounded-xl object-contain shadow-[0_24px_60px_rgba(0,0,0,0.6)] transition-transform duration-300 group-hover:scale-[1.03] group-hover:shadow-[0_28px_70px_rgba(0,0,0,0.7)] sm:h-[360px]"
                      />
                    ) : (
                      <div className="relative z-10 h-[300px] w-[214px] rounded-xl bg-gradient-to-br from-[#1a1a2e] to-[#0a0a12] shadow-[0_24px_60px_rgba(0,0,0,0.6)] sm:h-[360px] sm:w-[257px]" />
                    )}
                    {/* Subtle reflection/glow under card */}
                    <div className="pointer-events-none absolute -bottom-4 left-1/2 h-8 w-3/4 -translate-x-1/2 rounded-full bg-[#00B4D8]/[0.08] blur-xl" />
                  </div>

                  <div className="mt-6 w-full">
                    <h3 className="text-[20px] font-bold text-white sm:text-[22px]">{featuredCard.name}</h3>
                    <p className="mt-0.5 text-[13px] text-[#666]">{featuredCard.set_name}</p>

                    <div className="mt-4 grid grid-cols-3 gap-3 rounded-xl border border-white/[0.04] bg-white/[0.02] p-3">
                      <div>
                        <span className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Price</span>
                        <p className="mt-0.5 text-[20px] font-bold tabular-nums leading-tight text-white">{formatPrice(featuredCard.market_price)}</p>
                      </div>
                      <div className="text-center">
                        <span className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Direction</span>
                        <p className={`mt-0.5 text-[18px] font-bold leading-tight ${getDirectionMeta(featuredCard.market_direction)?.textClass ?? "text-[#D1D5DB]"}`}>
                          {getDirectionMeta(featuredCard.market_direction)?.label ?? "--"}
                        </p>
                        <p className={`mt-0.5 text-[13px] font-semibold tabular-nums ${(featuredCard.change_pct ?? 0) >= 0 ? "text-[#00DC5A]" : "text-[#FF6B6B]"}`}>
                          {formatPct(featuredCard.change_pct)}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Market Strength</span>
                        <p className="mt-0.5 text-[20px] font-bold tabular-nums leading-tight text-[#00B4D8]">
                          {formatMarketStrength(featuredCard.market_strength_score)}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            )}

            {/* Movers Grid */}
            <div className="space-y-4">
              {/* High Confidence Movers */}
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-white">Strong Movers</span>
                  <span className="rounded-md bg-[#00DC5A]/10 px-2 py-0.5 text-[10px] font-bold text-[#00DC5A]">{strongMoversBadge}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {strongMoverCards.map((card) => (
                    <MoverCard key={card.slug} card={card} />
                  ))}
                  {strongMoverCards.length === 0 && (
                    <div className="col-span-2 flex h-24 items-center justify-center rounded-xl border border-white/[0.04] text-[13px] text-[#444]">
                      No high-confidence movers yet
                    </div>
                  )}
                </div>
              </div>

              {/* Biggest Drops */}
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-white">Largest Pullbacks</span>
                  <span className="rounded-md bg-[#FF3B30]/10 px-2 py-0.5 text-[10px] font-bold text-[#FF3B30]">{pullbacksBadge}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {dropCards.slice(0, 4).map((card) => (
                    <MoverCard key={card.slug} card={card} />
                  ))}
                  {dropCards.length === 0 && (
                    <div className="col-span-2 flex h-24 items-center justify-center rounded-xl border border-white/[0.04] text-[13px] text-[#444]">
                      No drops data yet
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trending Rail ───────────────────────────────────────────────── */}
      <section className="border-t border-white/[0.04] py-16 sm:py-20">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
          <div className="flex items-end justify-between">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#7C3AED]">Momentum</span>
              <h2 className="mt-2 text-[clamp(1.5rem,3vw,2rem)] font-bold tracking-tight text-white">Sustained momentum</h2>
            </div>
            <Link href="/search" className="text-[13px] font-medium text-[#00B4D8] transition-colors hover:text-white">
              View all →
            </Link>
          </div>

          <div
            className="landing-scroll-rail mt-6 flex gap-4 overflow-x-auto pb-4"
            style={{ scrollSnapType: "x mandatory" }}
          >
            {trendingCards.map((card) => (
              <Link
                key={card.slug}
                href={`/c/${encodeURIComponent(card.slug)}`}
                className="group w-[220px] shrink-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0C0C10] transition-all hover:border-[#00B4D8]/20 hover:shadow-[0_12px_40px_rgba(0,180,216,0.08)] sm:w-[240px]"
                style={{ scrollSnapAlign: "start" }}
              >
                {/* Card image with premium framing */}
                <div className="relative overflow-hidden bg-gradient-to-b from-[#12121a] to-[#0C0C10] p-4 pb-3">
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent" />
                  {card.image_url ? (
                    <img
                      src={card.image_url}
                      alt={card.name}
                      className="relative mx-auto aspect-[63/88] w-full rounded-lg object-cover shadow-[0_12px_35px_rgba(0,0,0,0.5)] transition-transform duration-300 group-hover:scale-[1.04] group-hover:shadow-[0_16px_45px_rgba(0,0,0,0.6)]"
                    />
                  ) : (
                    <div className="mx-auto aspect-[63/88] w-full rounded-lg bg-gradient-to-br from-[#1a1a2e] to-[#0a0a12] shadow-[0_12px_35px_rgba(0,0,0,0.5)]" />
                  )}
                </div>
                {/* Card details */}
                <div className="px-4 pb-4">
                  <p className="truncate text-[14px] font-semibold text-[#E4E4E7] group-hover:text-white">{card.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-[#555]">{card.set_name}</p>
                  <div className="mt-2.5 flex items-center justify-between border-t border-white/[0.04] pt-2.5">
                    <span className="text-[15px] font-bold tabular-nums text-white">{formatPrice(card.market_price)}</span>
                    <span className={`rounded-md px-1.5 py-0.5 text-[12px] font-bold tabular-nums ${(card.change_pct ?? 0) >= 0 ? "bg-[#00DC5A]/10 text-[#00DC5A]" : "bg-[#FF3B30]/10 text-[#FF3B30]"}`}>
                      {formatPct(card.change_pct)}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
            {trendingCards.length === 0 && (
              <div className="flex h-40 w-full items-center justify-center text-[13px] text-[#444]">
                No trending cards yet
              </div>
            )}
          </div>

          {/* Emerging Movers sub-section */}
          {emergingMovers.length > 0 && (
            <div className="mt-10">
              <div className="mb-4 flex items-center gap-2">
                <span className="text-[13px] font-semibold text-white">Emerging Movers</span>
                <span className="rounded-md bg-[#00DC5A]/10 px-2 py-0.5 text-[10px] font-bold text-[#00DC5A]">NEW</span>
              </div>
              <div
                className="landing-scroll-rail flex gap-4 overflow-x-auto pb-4"
                style={{ scrollSnapType: "x mandatory" }}
              >
                {emergingMovers.slice(0, 5).map((card) => (
                  <Link
                    key={card.slug}
                    href={`/c/${encodeURIComponent(card.slug)}`}
                    className="group w-[220px] shrink-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0C0C10] transition-all hover:border-[#00DC5A]/20 hover:shadow-[0_12px_40px_rgba(0,220,90,0.06)] sm:w-[240px]"
                    style={{ scrollSnapAlign: "start" }}
                  >
                    <div className="relative overflow-hidden bg-gradient-to-b from-[#12121a] to-[#0C0C10] p-4 pb-3">
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent" />
                      {card.image_url ? (
                        <img
                          src={card.image_url}
                          alt={card.name}
                          className="relative mx-auto aspect-[63/88] w-full rounded-lg object-cover shadow-[0_12px_35px_rgba(0,0,0,0.5)] transition-transform duration-300 group-hover:scale-[1.04]"
                        />
                      ) : (
                        <div className="mx-auto aspect-[63/88] w-full rounded-lg bg-gradient-to-br from-[#1a1a2e] to-[#0a0a12] shadow-[0_12px_35px_rgba(0,0,0,0.5)]" />
                      )}
                    </div>
                    <div className="px-4 pb-4">
                      <p className="truncate text-[14px] font-semibold text-[#E4E4E7]">{card.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-[#555]">{card.set_name}</p>
                    </div>
                    <div className="px-4 pb-4 flex items-center justify-between border-t border-white/[0.04] pt-2.5 -mt-1">
                      <span className="text-[15px] font-bold tabular-nums text-white">{formatPrice(card.market_price)}</span>
                      <span className={`rounded-md px-1.5 py-0.5 text-[12px] font-bold tabular-nums ${(card.change_pct ?? 0) >= 0 ? "bg-[#00DC5A]/10 text-[#00DC5A]" : "bg-[#FF3B30]/10 text-[#FF3B30]"}`}>
                        {formatPct(card.change_pct)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Market Intelligence ─────────────────────────────────────────── */}
      <section className="border-t border-white/[0.04] bg-[#08080C] py-16 sm:py-24">
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
                  {["Narrow breadth", "Conviction building", "Chase-led market"].map((tag) => (
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
                    Ace goes deeper on breadth, set rotation, conviction flow, crowd divergence, and risk. Updated live.
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
              Beyond price: context, conviction, and market strength
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-[#666]">
              PopAlpha combines live pricing, confidence scoring, momentum tracking, and AI market briefs in one collector-native workflow.
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
                desc: "Daily reads on what is moving, why it matters, and where conviction is building.",
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
                  "Momentum and conviction tracking",
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
            Start tracking with context
            <br />
            <span className="bg-gradient-to-r from-[#00B4D8] to-[#00DC5A] bg-clip-text text-transparent">and conviction</span>
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

function MoverCard({ card }: { card: HomepageCard }) {
  const isPositive = (card.change_pct ?? 0) >= 0;
  const directionMeta = getDirectionMeta(card.market_direction);
  return (
    <Link
      href={`/c/${encodeURIComponent(card.slug)}`}
      className="group relative overflow-hidden rounded-xl border border-white/[0.06] bg-[#0C0C10] p-3 transition-all hover:border-white/[0.12] hover:bg-[#0E0E14] hover:shadow-[0_8px_30px_rgba(0,0,0,0.3)]"
    >
      <div className="flex gap-3.5">
        {/* Card image — larger with premium shadow */}
        <div className="relative shrink-0">
          {card.image_url ? (
            <img
              src={card.image_url}
              alt=""
              className="h-[72px] w-[52px] rounded-lg object-cover shadow-[0_6px_20px_rgba(0,0,0,0.4)] transition-transform duration-200 group-hover:scale-[1.05]"
            />
          ) : (
            <div className="h-[72px] w-[52px] rounded-lg bg-gradient-to-b from-[#1a1a2e] to-[#0a0a12] shadow-[0_6px_20px_rgba(0,0,0,0.4)]" />
          )}
          {/* Subtle glow under card on hover */}
          <div className="pointer-events-none absolute -bottom-1 left-1/2 h-3 w-10 -translate-x-1/2 rounded-full bg-[#00B4D8]/0 blur-md transition-all group-hover:bg-[#00B4D8]/[0.1]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-[#E4E4E7] group-hover:text-white">{card.name}</p>
          <p className="truncate text-[11px] text-[#555]">{card.set_name}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[14px] font-bold tabular-nums text-white">{formatPrice(card.market_price)}</span>
            <span className={`text-[13px] font-semibold tabular-nums ${isPositive ? "text-[#00DC5A]" : "text-[#FF3B30]"}`}>
              {formatPct(card.change_pct)}
            </span>
          </div>
          {(card.market_strength_score !== null || directionMeta) ? (
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#666]">
                Market Strength{" "}
                <span className="text-[#D4D4D8]">
                  {formatMarketStrength(card.market_strength_score)}
                </span>
              </span>
              {directionMeta ? (
                <span className={`text-[11px] font-semibold ${directionMeta.textClass}`}>
                  {directionMeta.label}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {card.mover_tier === "hot" && (
          <span className="shrink-0 self-start rounded-md bg-[#FF6B35]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#FF6B35]">HOT</span>
        )}
      </div>
    </Link>
  );
}
