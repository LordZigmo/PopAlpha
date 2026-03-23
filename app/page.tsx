import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { Sparkles } from "lucide-react";
import { getHomepageData, type HomepageCard } from "@/lib/data/homepage";
import { getCommunityPulseSnapshot } from "@/lib/data/community-pulse";
import { getPopAlphaModel } from "@/lib/ai/models";
import CommunityPulseBoard from "@/components/community-pulse-board";
import HomepageSearch from "@/components/homepage-search";
import SectionCarousel from "@/components/section-carousel";
import CardTileMini from "@/components/card-tile-mini";
import ProSectionLocked from "@/components/pro-section-locked";
import TypewriterText from "@/components/typewriter-text";

export const dynamic = "force-dynamic";

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

function formatExactTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

const EMPTY_DATA = {
  movers: [],
  high_confidence_movers: [],
  emerging_movers: [],
  losers: [],
  trending: [],
  as_of: null,
} as const;
const DATA_TIMEOUT_MS = 8_000; // under Vercel's 10s function limit
const AI_TIMEOUT_MS = 4_000;
const TRENDING_SET_PILLS = [
  "Prismatic Evolutions",
  "151",
  "Evolving Skies",
] as const;
const HERO_HEADLINE = "Market Intelligence for Pokemon Collectors";
const HERO_SUBHEADLINE = "Live pricing, confidence scores, and AI market reads for serious collectors.";
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

function getNarrativeHeading(tier: PopAlphaTier): string {
  if (tier === "Elite") return "PopAlpha Elite";
  if (tier === "Ace") return "PopAlpha Ace";
  return "PopAlpha Scout";
}

function getNarrativeSubheading(tier: PopAlphaTier): string {
  if (tier === "Elite") return "Deepest market read";
  if (tier === "Ace") return "Deeper market read";
  return "Live market read";
}

function getNarrativeAccent(tier: PopAlphaTier): string {
  if (tier === "Elite") return "text-[#8FBFFF]";
  if (tier === "Ace") return "text-[#C7D2FE]";
  return "text-[#63D471]";
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
    if (tier === "Elite") {
      return "The market is still mixed. Money is moving around, but it has not settled into one clear theme yet.";
    }
    if (tier === "Ace") {
      return "The market is still mixed. Buyers are rotating instead of pressing one clear pocket of strength.";
    }
    return "The market is still mixed. No set is clearly in control yet.";
  }

  if ((rankedSets[0]?.[1] ?? 0) >= 3) {
    if (tier === "Elite") {
      return `${leader} has the clearest strength right now. Buyers keep coming back to the same names, which is a strong sign.`;
    }
    if (tier === "Ace") {
      return `${leader} is leading today. The strongest movers keep coming from the same set, which looks like real conviction.`;
    }
    return `${leader} is leading today. The strongest moves keep showing up in the same set.`;
  }

  if (runnerUp) {
    if (tier === "Elite") {
      return `Strength is split between ${leader} and ${runnerUp}. Buyers look interested in more than one part of the market.`;
    }
    if (tier === "Ace") {
      return `Strength is split between ${leader} and ${runnerUp}. Buyers are widening out instead of chasing one crowded move.`;
    }
    return `The action is split between ${leader} and ${runnerUp}. No single set is taking over yet.`;
  }

  if (tier === "Elite") {
    return `${leader} has the clearest strength right now, but the rest of the market still looks selective.`;
  }
  if (tier === "Ace") {
    return `${leader} has the clearest momentum right now, but the rest of the market still looks selective.`;
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

  const explicitParagraphs = trimmed
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (explicitParagraphs.length >= 2) {
    return `${explicitParagraphs[0]}\n\n${explicitParagraphs[1]}`;
  }

  const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [trimmed];

  if (sentences.length <= 1) {
    return `${trimmed}\n\nThe board is worth watching, but the next edge depends on where conviction builds.`;
  }

  const midpoint = Math.ceil(sentences.length / 2);
  const first = sentences.slice(0, midpoint).join(" ").trim();
  const second = sentences.slice(midpoint).join(" ").trim();

  return `${first}\n\n${second || "The board is worth watching, but the next edge depends on where conviction builds."}`;
}

function normalizeEliteSummary(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const explicitParagraphs = trimmed
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (explicitParagraphs.length >= 3) {
    return `${explicitParagraphs[0]}\n\n${explicitParagraphs[1]}\n\n${explicitParagraphs[2]}`;
  }

  const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [trimmed];

  if (sentences.length <= 2) {
    return `${trimmed}\n\nThe best edge still depends on whether the same cards keep pulling real money and real attention.\n\nIf that breaks apart, the board can cool off fast.`;
  }

  const chunkSize = Math.max(1, Math.ceil(sentences.length / 3));
  const first = sentences.slice(0, chunkSize).join(" ").trim();
  const second = sentences.slice(chunkSize, chunkSize * 2).join(" ").trim();
  const third = sentences.slice(chunkSize * 2).join(" ").trim();

  return `${first}\n\n${second || "The best edge still depends on whether the same cards keep pulling real money and real attention."}\n\n${third || "If that breaks apart, the board can cool off fast."}`;
}

function splitAcePreview(text: string): { lead: string; remainder: string } {
  const flattened = text.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  if (!flattened) return { lead: "", remainder: "" };

  const firstSentence = flattened.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/)?.[0]?.trim() ?? flattened;
  const remainder = flattened.slice(firstSentence.length).trim();
  return {
    lead: firstSentence,
    remainder,
  };
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
    ...movers.slice(0, 2).map((card, index) =>
      `Top mover ${index + 1}: ${card.name} (${card.set_name ?? "Unknown set"}) at ${card.market_price != null ? `$${card.market_price}` : "unknown"} with ${card.change_pct != null ? `${card.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...trending.slice(0, 2).map((card, index) =>
      `Trending ${index + 1}: ${card.name} (${card.set_name ?? "Unknown set"}) at ${card.market_price != null ? `$${card.market_price}` : "unknown"} with ${card.change_pct != null ? `${card.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...losers.slice(0, 1).map((card) =>
      `Biggest drop: ${card.name} (${card.set_name ?? "Unknown set"}) with ${card.change_pct != null ? `${card.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...communityCards.slice(0, 3).map((card, index) => {
      const totalVotes = card.bullishVotes + card.bearishVotes;
      const bullishPct = totalVotes > 0 ? Math.round((card.bullishVotes / totalVotes) * 100) : 50;
      return `Community pulse ${index + 1}: ${card.name} (${card.setName ?? "Unknown set"}) has ${bullishPct}% bullish sentiment across ${totalVotes} votes and ${card.changePct != null ? `${card.changePct.toFixed(2)}%` : "unknown"} change.`;
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

    const text = normalizeAceSummary(result.text);
    return text || fallback;
  } catch {
    return fallback;
  }
}

function buildEliteNarrativeFallback(
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
  const runner = movers[1] ?? trending[0];
  const laggard = losers[0];
  const communityLeader = communityCards[0];
  const communityTotal = communityLeader ? communityLeader.bullishVotes + communityLeader.bearishVotes : 0;
  const bullishPct = communityLeader && communityTotal > 0
    ? Math.round((communityLeader.bullishVotes / communityTotal) * 100)
    : null;

  return [
    "The mood is firmer than the board is broad. Collectors are focused on a few names, not buying everything in sight.",
    laggard
      ? `${leader ? `${leader.name} is one of the clearest leaders right now, and ${runner ? `${runner.name} is helping widen the move.` : "leadership is still fairly narrow."}` : "Leadership is still narrow."} ${laggard.name} is softer, which shows buyers are still choosing carefully.`
      : `${leader ? `${leader.name} is one of the clearest leaders right now.` : "Leadership is still narrow."} The weak side still matters because it shows where conviction is not holding.`,
    communityLeader
      ? `${communityLeader.name} is also getting about ${bullishPct ?? 50}% bullish community votes. When price, attention, and sentiment point the same way, the move is easier to trust.`
      : "The next key signal is whether community votes line up with the same cards already holding price. When that happens, the move is easier to trust.",
  ].join("\n\n");
}

async function generateEliteSummary(
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
  const fallback = buildEliteNarrativeFallback(movers, trending, losers, communityCards);
  const topContext = [
    ...movers.slice(0, 3).map((card, index) =>
      `Top mover ${index + 1}: ${card.name} (${card.set_name ?? "Unknown set"}) at ${card.market_price != null ? `$${card.market_price}` : "unknown"} with ${card.change_pct != null ? `${card.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...trending.slice(0, 2).map((card, index) =>
      `Trending ${index + 1}: ${card.name} (${card.set_name ?? "Unknown set"}) at ${card.market_price != null ? `$${card.market_price}` : "unknown"} with ${card.change_pct != null ? `${card.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...losers.slice(0, 2).map((card, index) =>
      `Weak name ${index + 1}: ${card.name} (${card.set_name ?? "Unknown set"}) with ${card.change_pct != null ? `${card.change_pct.toFixed(2)}%` : "unknown"} change.`,
    ),
    ...communityCards.slice(0, 4).map((card, index) => {
      const totalVotes = card.bullishVotes + card.bearishVotes;
      const currentBullishPct = totalVotes > 0 ? Math.round((card.bullishVotes / totalVotes) * 100) : 50;
      return `Community signal ${index + 1}: ${card.name} (${card.setName ?? "Unknown set"}) has ${currentBullishPct}% bullish sentiment across ${totalVotes} votes and ${card.changePct != null ? `${card.changePct.toFixed(2)}%` : "unknown"} change.`;
    }),
  ].join("\n");

  try {
    const result = await Promise.race([
      generateText({
        model: getPopAlphaModel("Elite"),
        system: [
          "You are PopAlpha Elite Summary, the deepest market note on the homepage.",
          "Write in plain English at about an 8th-grade reading level.",
          "Use short sentences and common words.",
          "Sound calm, premium, and useful.",
          "Avoid hype, slang, and heavy finance jargon.",
          "Use the supplied strength, weakness, rotation, and community vote signals.",
          "Write exactly 3 short paragraphs.",
          "Use no more than 2 sentences per paragraph.",
          "Paragraph 1 should describe the market mood.",
          "Paragraph 2 should describe the leaders and weak names.",
          "Paragraph 3 should explain what confirms or weakens the move next.",
          "Do not mention being an AI, and do not invent metrics.",
        ].join(" "),
        prompt: [
          "Use only the supplied homepage and community pulse data.",
          "Describe the market in a short, clear way for serious collectors.",
          "Call out where conviction looks real, where it looks thin, and what would confirm or weaken the move.",
          "",
          topContext,
        ].join("\n"),
      }),
      new Promise<{ text: string }>((resolve) =>
        setTimeout(() => resolve({ text: fallback }), AI_TIMEOUT_MS),
      ),
    ]);

    const text = normalizeEliteSummary(result.text);
    return text || fallback;
  } catch {
    return fallback;
  }
}

export default async function HomePage() {
  console.log("[homepage] rendering started", new Date().toISOString());
  const user = await currentUser();
  let data;
  try {
    data = await Promise.race([
      getHomepageData(),
      new Promise<typeof EMPTY_DATA>((resolve) =>
        setTimeout(() => {
          console.warn("[homepage] data fetch timed out after", DATA_TIMEOUT_MS, "ms");
          resolve(EMPTY_DATA);
        }, DATA_TIMEOUT_MS),
      ),
    ]);
    console.log("[homepage] data resolved:", {
      movers: data?.movers?.length ?? 0,
      high_confidence_movers: data?.high_confidence_movers?.length ?? 0,
      losers: data?.losers?.length ?? 0,
      trending: data?.trending?.length ?? 0,
    });
  } catch (err) {
    console.error("[homepage] getHomepageData threw:", err);
    data = EMPTY_DATA;
  }

  const movers = Array.isArray(data?.movers) ? data.movers : [];
  const highConfidenceMovers = Array.isArray(data?.high_confidence_movers) ? data.high_confidence_movers : [];
  const losers = Array.isArray(data?.losers) ? data.losers : [];
  const trending = Array.isArray(data?.trending) ? data.trending : [];
  const asOf = timeAgo(data?.as_of ?? null);
  const summaryUpdatedAgo = asOf || "just now";
  const railUpdatedLabel = data?.as_of && asOf ? `Updated ${asOf}` : null;
  const railUpdatedTitle = formatExactTimestamp(data?.as_of ?? null);
  const heroStatus = asOf ? `Signal refreshed ${asOf}` : "Signal refreshed live";
  const heroPrimaryHref = user ? "/search" : "/sign-up";
  const userTier = getTierLabel(
    user?.publicMetadata.subscriptionTier ?? user?.publicMetadata.tier ?? user?.publicMetadata.plan,
  );
  const narrativeHeading = getNarrativeHeading(userTier);
  const narrativeSubheading = getNarrativeSubheading(userTier);
  const narrativeAccent = getNarrativeAccent(userTier);
  const marketNarrative = buildMarketNarrative(userTier, movers, losers, trending);
  const communityPulse = await getCommunityPulseSnapshot(
    [...movers, ...trending, ...losers],
    user?.id ?? null,
  );
  const aceSummary = await generateAceSummary(
    movers,
    trending,
    losers,
    communityPulse.cards.map((card) => ({
      name: card.name,
      setName: card.setName,
      bullishVotes: card.bullishVotes,
      bearishVotes: card.bearishVotes,
      changePct: card.changePct,
    })),
  );
  const eliteSummary = await generateEliteSummary(
    movers,
    trending,
    losers,
    communityPulse.cards.map((card) => ({
      name: card.name,
      setName: card.setName,
      bullishVotes: card.bullishVotes,
      bearishVotes: card.bearishVotes,
      changePct: card.changePct,
    })),
  );
  const acePreview = splitAcePreview(aceSummary);
  const elitePreview = splitAcePreview(eliteSummary);

  return (
    <main className="min-h-screen bg-[#0A0A0A] text-[#F0F0F0] pb-16">
      {/* ── Header / Search ──────────────────────────────────────────── */}
      <div className="mx-auto max-w-5xl px-4 pt-16 sm:px-6 sm:pt-20">
        <div className="flex items-baseline justify-between gap-4">
          <div className="max-w-4xl">
            <div className="flex items-start gap-4 sm:gap-5">
              <Image
                src="/brand/popalpha-icon.svg"
                alt=""
                aria-hidden="true"
                width={112}
                height={112}
                className="h-20 w-20 shrink-0 sm:h-24 sm:w-24"
                priority
              />
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#63D7FF]">
                  PopAlpha
                </p>
                <h1 className="mt-2 max-w-4xl text-[40px] font-bold leading-[0.96] tracking-tight text-[#F0F0F0] sm:text-5xl lg:text-6xl">
                  {HERO_HEADLINE}
                </h1>
              </div>
            </div>
            <p className="mt-4 max-w-3xl text-[18px] leading-8 text-[#B5B5B5] sm:text-[20px]">
              {HERO_SUBHEADLINE}
            </p>
            <p className="mt-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7FC8FF] sm:text-[12px]">
              <span aria-hidden="true" className="inline-flex h-2 w-2 rounded-full bg-[#63D471]" />
              {heroStatus}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href={heroPrimaryHref}
                className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-white px-6 py-3 text-[15px] font-semibold text-[#0A0A0A] transition hover:bg-[#EAEAEA]"
              >
                {HERO_PRIMARY_CTA}
              </Link>
              <Link
                href="#live-market"
                className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] px-6 py-3 text-[15px] font-semibold text-[#F0F0F0] transition hover:border-white/[0.2] hover:bg-white/[0.06]"
              >
                {HERO_SECONDARY_CTA}
              </Link>
            </div>
          </div>
        </div>

        <div className="sticky top-3 z-30 mt-5">
          <div className="rounded-[2rem] border border-white/[0.08] bg-white/[0.06] px-3 py-3 shadow-[0_24px_90px_rgba(0,0,0,0.36)] backdrop-blur-2xl">
            <Suspense
              fallback={
                <div className="h-[60px] rounded-full border border-white/[0.06] bg-[#111] opacity-40" />
              }
            >
              <HomepageSearch />
            </Suspense>

            <div className="mt-3 px-1">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold tracking-[0.02em] text-[#D7DBE6]">
                <span>In focus</span>
                <span aria-hidden="true" className="text-[#63D471]">↗</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {TRENDING_SET_PILLS.map((setName) => (
                  <Link
                    key={setName}
                    href={`/search?q=${encodeURIComponent(setName)}`}
                    className="rounded-full border border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-[#B5B5B5] transition hover:border-white/[0.14] hover:text-white"
                  >
                    {setName}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div
          className={[
            "relative mt-4 overflow-hidden rounded-2xl px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.24)]",
            userTier === "Trainer"
              ? "border border-[#63D471]/25 border-l-4 border-l-emerald-500 bg-emerald-500/10 shadow-[0_0_28px_rgba(16,185,129,0.20),0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-md"
              : "border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl",
          ].join(" ")}
        >
          {userTier === "Trainer" ? (
            <span className="pointer-events-none absolute inset-y-0 -left-1 w-1/2 scout-holo-shimmer" aria-hidden="true" />
          ) : null}
          <div className="relative z-10 flex items-start justify-between gap-4">
            <div>
              <div
                className={[
                  "flex items-center gap-2",
                  userTier === "Trainer"
                    ? "text-[30px] font-semibold tracking-[-0.03em] text-emerald-400 sm:text-[32px]"
                    : `text-[11px] font-semibold uppercase tracking-[0.18em] ${narrativeAccent}`,
                ].join(" ")}
              >
                {userTier === "Trainer" ? <Sparkles size={14} strokeWidth={2.2} className="text-emerald-300" /> : null}
                {narrativeHeading}
              </div>
              <p
                className={[
                  "mt-1 text-[12px] font-medium tracking-[0.04em] sm:text-[13px]",
                  userTier === "Trainer" ? "text-emerald-200/85" : "text-[#D6E6FF]/82",
                ].join(" ")}
              >
                {narrativeSubheading}
              </p>
            </div>
            {userTier === "Trainer" ? (
              <div className="flex shrink-0 flex-col items-end">
                <span className="inline-flex h-[2.25rem] items-center gap-2 self-start rounded-full border border-red-500/20 bg-red-500/10 px-3 text-[18px] font-semibold leading-none tracking-[-0.01em] text-red-100">
                  <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                    <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-red-500 opacity-75 animate-ping" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                  </span>
                  Live
                </span>
                <span className="mt-1 pr-1 text-[11px] font-medium tracking-[0.04em] text-emerald-200/75">
                  {summaryUpdatedAgo}
                </span>
              </div>
            ) : null}
          </div>
          <TypewriterText
            text={userTier === "Trainer" ? HOMEPAGE_SCOUT_NARRATIVE : marketNarrative}
            className={[
              "relative z-10 mt-2 leading-relaxed",
              userTier === "Trainer" ? "text-[18px] font-medium text-emerald-50 sm:text-[19px]" : "text-base sm:text-[17px] text-[#D7DBE6]",
            ].join(" ")}
          />
        </div>
      </div>

      {/* ── High-Confidence Movers ───────────────────────────────────── */}
      <SectionCarousel
        id="live-market"
        title="Strong Movers"
        subtitle="24h gains with real signal"
        stamp={railUpdatedLabel}
        stampTitle={railUpdatedTitle}
        stampDateTime={data?.as_of ?? null}
      >
        {highConfidenceMovers.length > 0
          ? highConfidenceMovers.slice(0, 5).map((card) => (
              <CardTileMini key={card.slug} card={card} />
            ))
          : null}
        {highConfidenceMovers.length === 0 ? (
          <EmptySlot message="No strong movers yet" />
        ) : null}
      </SectionCarousel>
      <div className="mx-auto mt-6 max-w-5xl border-b border-white/5 px-4 sm:px-6 lg:px-0" />

      {/* ── Top Losers ───────────────────────────────────────────────── */}
      <SectionCarousel
        title="Largest Pullbacks"
        icon="📉"
        subtitle="24h drops under pressure"
        stamp={railUpdatedLabel}
        stampTitle={railUpdatedTitle}
        stampDateTime={data?.as_of ?? null}
      >
        {losers.length > 0
          ? losers.slice(0, 5).map((card) => (
              <CardTileMini key={card.slug} card={card} />
            ))
          : null}
        {losers.length === 0 ? (
          <EmptySlot message="No pullbacks yet" />
        ) : null}
      </SectionCarousel>

      {/* ── Trending ─────────────────────────────────────────────────── */}
      <SectionCarousel
        title="Sustained Momentum"
        icon="📈"
        subtitle="strength with follow-through"
        stamp={railUpdatedLabel}
        stampTitle={railUpdatedTitle}
        stampDateTime={data?.as_of ?? null}
      >
        {trending.length > 0
          ? trending.slice(0, 5).map((card) => (
              <CardTileMini key={card.slug} card={card} />
            ))
          : null}
        {trending.length === 0 ? (
          <EmptySlot message="No momentum leaders yet" />
        ) : null}
      </SectionCarousel>

      {/* ── Community Pulse (coming soon) ─────────────────────────────── */}
      <section className="mt-8 lg:mx-auto lg:max-w-5xl lg:px-6">
        <div className="px-4 sm:px-6 lg:px-0">
          <CommunityPulseBoard
            cards={communityPulse.cards}
            votesRemaining={communityPulse.votesRemaining}
            weeklyLimit={communityPulse.weeklyLimit}
            weekEndsAt={communityPulse.weekEndsAt}
            signedIn={!!user}
          />
        </div>
      </section>

      <section className="mt-6 lg:mx-auto lg:max-w-5xl lg:px-6">
        <div className="px-4 sm:px-6 lg:px-0">
          <div className="relative overflow-hidden rounded-2xl border border-[#60A5FA]/25 border-l-4 border-l-[#60A5FA] bg-[#60A5FA]/10 px-4 py-3 shadow-[0_0_28px_rgba(96,165,250,0.18),0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-md">
            <span
              className="pointer-events-none absolute inset-y-0 -left-1 w-1/2"
              aria-hidden="true"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, rgba(147,197,253,0.02) 18%, rgba(191,219,254,0.16) 48%, rgba(147,197,253,0.03) 72%, transparent 100%)",
                animation: "scoutHoloSweep 8s linear infinite",
              }}
            />
            <div className="relative z-10 flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[30px] font-semibold tracking-[-0.03em] text-[#93C5FD] sm:text-[32px]">
                  <Sparkles size={14} strokeWidth={2.2} className="text-[#BFDBFE]" />
                  PopAlpha Ace
                </div>
                <p className="mt-1 text-[12px] font-medium tracking-[0.04em] text-[#D6E6FF]/88 sm:text-[13px]">
                  Deeper market read
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className="inline-flex h-[2.25rem] items-center gap-2 self-start rounded-full border border-red-500/20 bg-red-500/10 px-3 text-[18px] font-semibold leading-none tracking-[-0.01em] text-red-100">
                  <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                    <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-red-500 opacity-75 animate-ping" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                  </span>
                  Live
                </span>
                <span className="mt-1 pr-1 text-[11px] font-medium tracking-[0.04em] text-[#D6E6FF]/72">
                  {summaryUpdatedAgo}
                </span>
              </div>
            </div>
            <div className="relative z-10 mt-2 text-[18px] font-medium leading-relaxed text-[#E5EEFF] sm:text-[19px]">
              <TypewriterText text={acePreview.lead} />
              {acePreview.remainder ? (
                <div className="relative mt-2 overflow-hidden rounded-xl">
                  <p className="blur-[3px] select-none text-[#D9E8FF]/80">
                    {acePreview.remainder}
                  </p>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#60A5FA]/8 to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="inline-flex items-center justify-center rounded-full border border-blue-400/20 bg-[linear-gradient(135deg,rgba(96,165,250,0.95),rgba(59,130,246,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(59,130,246,0.28)]">
                      Unlock Pro
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* ── Breakout Candidates (PRO) ────────────────────────────────── */}
      <ProSectionLocked
        title="Breakout Watch"
        icon="🧠"
        description="Unlock Pro to see names gaining strength"
      />

      {/* ── Undervalued vs Trend (PRO) ───────────────────────────────── */}
      <ProSectionLocked
        title="Value Watch"
        icon="💎"
        description="Unlock Pro to see prices that look out of line"
      />

      <SampleCommunityPostsSection />

      <MostViewedPlaceholderSection />
      <BestPredictorsPlaceholderSection />

      <section className="mt-8 lg:mx-auto lg:max-w-5xl lg:px-6">
        <div className="px-4 sm:px-6 lg:px-0">
          <div className="relative overflow-hidden rounded-2xl border border-violet-400/25 border-l-4 border-l-violet-400 bg-violet-400/10 px-4 py-3 shadow-[0_0_28px_rgba(167,139,250,0.18),0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-md">
            <span
              className="pointer-events-none absolute inset-y-0 -left-1 w-1/2"
              aria-hidden="true"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, rgba(196,181,253,0.02) 18%, rgba(221,214,254,0.16) 48%, rgba(196,181,253,0.03) 72%, transparent 100%)",
                animation: "scoutHoloSweep 8s linear infinite",
              }}
            />
            <div className="relative z-10 flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[30px] font-semibold tracking-[-0.03em] text-violet-300 sm:text-[32px]">
                  <Sparkles size={14} strokeWidth={2.2} className="text-violet-200" />
                  PopAlpha Elite
                </div>
                <p className="mt-1 text-[12px] font-medium tracking-[0.04em] text-violet-100/85 sm:text-[13px]">
                  Deepest market read
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className="inline-flex h-[2.25rem] items-center gap-2 self-start rounded-full border border-red-500/20 bg-red-500/10 px-3 text-[18px] font-semibold leading-none tracking-[-0.01em] text-red-100">
                  <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                    <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-red-500 opacity-75 animate-ping" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                  </span>
                  Live
                </span>
                <span className="mt-1 pr-1 text-[11px] font-medium tracking-[0.04em] text-violet-100/72">
                  {summaryUpdatedAgo}
                </span>
              </div>
            </div>
            <div className="relative z-10 mt-2 text-[18px] font-medium leading-relaxed text-violet-50 sm:text-[19px]">
              <TypewriterText text={elitePreview.lead} />
              {elitePreview.remainder ? (
                <div className="relative mt-2 overflow-hidden rounded-xl">
                  <p className="blur-[3px] select-none text-violet-100/80">
                    {elitePreview.remainder}
                  </p>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-violet-400/8 to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="inline-flex items-center justify-center rounded-full border border-violet-400/20 bg-[linear-gradient(135deg,rgba(139,92,246,0.95),rgba(99,102,241,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(99,102,241,0.28)]">
                      Unlock Elite
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function EmptySlot({ message }: { message: string }) {
  return (
    <div className="flex min-h-[140px] w-full items-center justify-center text-[13px] text-[#444] lg:col-span-5">
      {message}
    </div>
  );
}

const MOST_VIEWED_PLACEHOLDERS = [
  { codename: "Signal Leader", set: "Prismatic Evolutions", price: "$188", change: "+9.4%" },
  { codename: "Watchlist Surge", set: "151", price: "$124", change: "+6.8%" },
  { codename: "Heat Check", set: "Evolving Skies", price: "$242", change: "+11.2%" },
  { codename: "Crowd Magnet", set: "Twilight Masquerade", price: "$156", change: "+7.1%" },
  { codename: "Attention Spike", set: "Paldean Fates", price: "$98", change: "+5.6%" },
] as const;

function MostViewedPlaceholderSection() {
  return (
    <section className="mt-8 lg:mx-auto lg:max-w-5xl lg:px-6">
      <div className="flex items-baseline gap-2 px-4 sm:px-6 lg:px-0">
        <span className="text-lg">👁</span>
        <h2 className="text-[18px] font-semibold uppercase tracking-[0.06em] text-[#D4D4D8] sm:text-[20px]">
          Most Watched
        </h2>
        <span className="text-[14px] text-[#8A8A8A]">watchlist demand</span>
      </div>

      <div className="relative mt-3 px-4 sm:px-6 lg:px-0">
        <div
          className="flex gap-3 overflow-x-auto pb-2 select-none lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0"
          aria-hidden="true"
          style={{
            scrollSnapType: "x mandatory",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
          }}
        >
          {MOST_VIEWED_PLACEHOLDERS.map((row, index) => (
            <div
              key={`${row.codename}-${index}`}
              className="relative flex w-[172px] shrink-0 flex-col rounded-[1.05rem] border border-white/[0.04] bg-[#0D0D0D] p-3.5 lg:w-auto"
              style={{ filter: "blur(6px)", scrollSnapAlign: "start" }}
            >
              <div className="aspect-[63/88] w-full rounded-[1rem] bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.07),transparent_58%),linear-gradient(180deg,#111827,#0B0B0B)]" />
              <div className="mt-3">
                <p className="line-clamp-2 text-[14px] font-bold leading-tight text-[#ECECEC]">
                  {row.codename}
                </p>
                <p className="mt-1 truncate text-sm text-zinc-500">
                  {row.set}
                </p>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[14px] font-bold tabular-nums text-[#F0F0F0]">{row.price}</span>
                <span className="text-[13px] font-semibold tabular-nums text-[#7DD3FC]">{row.change}</span>
              </div>
              <span className="mt-2 inline-flex w-fit items-center rounded-full bg-sky-400/[0.08] px-2 py-0.5 text-[10px] font-semibold text-sky-200">
                Heavy watchlists
              </span>
              <div className="pointer-events-none absolute inset-0 rounded-[1.05rem] border border-white/[0.04]" />
            </div>
          ))}
        </div>

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="inline-flex items-center justify-center rounded-full border border-violet-400/20 bg-[linear-gradient(135deg,rgba(139,92,246,0.95),rgba(99,102,241,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(99,102,241,0.28)]">
            Unlock Elite
          </div>
        </div>
      </div>
    </section>
  );
}

const BEST_PREDICTOR_PLACEHOLDERS = [
  { name: "AlphaMint", hitRate: "81%", streak: "9 straight" },
  { name: "SleeveSniper", hitRate: "78%", streak: "6 straight" },
  { name: "RareSignal", hitRate: "76%", streak: "5 straight" },
  { name: "HoloWatch", hitRate: "74%", streak: "4 straight" },
  { name: "SetRunner", hitRate: "72%", streak: "4 straight" },
] as const;

const SAMPLE_COMMUNITY_POSTS = [
  {
    handle: "@SleeveSniper",
    time: "12m ago",
    body:
      "The market still feels narrow. The better move may be the cards that keep holding price while the chase names get all the attention.",
  },
  {
    handle: "@HoloWatch",
    time: "27m ago",
    body:
      "Sentiment is getting stronger this week. I want to see if the same cards keep getting votes, watchlist adds, and price support.",
  },
] as const;

function BestPredictorsPlaceholderSection() {
  return (
    <section className="mt-8 lg:mx-auto lg:max-w-5xl lg:px-6">
      <div className="flex items-baseline gap-2 px-4 sm:px-6 lg:px-0">
        <span className="text-lg">🏆</span>
        <h2 className="text-[18px] font-semibold uppercase tracking-[0.06em] text-[#D4D4D8] sm:text-[20px]">
          Best Calls
        </h2>
        <span className="text-[14px] text-[#8A8A8A]">weekly hit rate</span>
      </div>

      <div className="relative mt-3 px-4 sm:px-6 lg:px-0">
        <div
          className="flex gap-3 overflow-x-auto pb-2 select-none lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0"
          aria-hidden="true"
          style={{
            scrollSnapType: "x mandatory",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
          }}
        >
          {BEST_PREDICTOR_PLACEHOLDERS.map((row, index) => (
            <div
              key={`${row.name}-${index}`}
              className="relative flex w-[172px] shrink-0 flex-col rounded-[1.05rem] border border-white/[0.04] bg-[#0D0D0D] p-3.5 lg:w-auto"
              style={{ filter: "blur(6px)", scrollSnapAlign: "start" }}
            >
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 rounded-full bg-[radial-gradient(circle_at_35%_30%,rgba(255,255,255,0.18),transparent_38%),linear-gradient(180deg,#1F2937,#0B0B0B)]" />
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-bold text-[#ECECEC]">{row.name}</p>
                  <p className="truncate text-[12px] text-zinc-500">Signal Desk</p>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-[12px] text-zinc-500">Hit Rate</span>
                <span className="text-[14px] font-bold tabular-nums text-[#F0F0F0]">{row.hitRate}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[12px] text-zinc-500">Streak</span>
                <span className="text-[13px] font-semibold text-[#7DD3FC]">{row.streak}</span>
              </div>
              <div className="mt-3 h-1.5 rounded-full bg-white/[0.06]">
                <div className="h-1.5 w-3/4 rounded-full bg-[linear-gradient(90deg,#60A5FA,#818CF8)]" />
              </div>
              <div className="pointer-events-none absolute inset-0 rounded-[1.05rem] border border-white/[0.04]" />
            </div>
          ))}
        </div>

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="inline-flex items-center justify-center rounded-full border border-violet-400/20 bg-[linear-gradient(135deg,rgba(139,92,246,0.95),rgba(99,102,241,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(99,102,241,0.28)]">
            Unlock Elite
          </div>
        </div>
      </div>
    </section>
  );
}

function SampleCommunityPostsSection() {
  return (
    <section className="mt-10 lg:mx-auto lg:max-w-5xl lg:px-6">
      <div className="flex items-baseline gap-2 px-4 sm:px-6 lg:px-0">
        <span className="text-lg">💬</span>
        <h2 className="text-[18px] font-semibold uppercase tracking-[0.06em] text-[#D4D4D8] sm:text-[20px]">
          Collector Notes
        </h2>
        <span className="text-[14px] text-[#8A8A8A]">collector views</span>
      </div>

      <div className="mt-5 grid gap-5 px-4 sm:px-6 lg:px-0">
        {SAMPLE_COMMUNITY_POSTS.map((post) => (
          <article
            key={`${post.handle}-${post.time}`}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.03] px-6 py-5 shadow-[0_12px_40px_rgba(0,0,0,0.16)] backdrop-blur-sm sm:px-7 sm:py-6"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px] font-semibold text-[#E4E4E7]">{post.handle}</span>
              <span className="text-[13px] text-[#71717A]">{post.time}</span>
            </div>
            <p className="mt-3 max-w-[56rem] text-[18px] leading-relaxed text-[#D4D4D8] sm:text-[19px]">
              {post.body}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
