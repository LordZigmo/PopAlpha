import { Suspense } from "react";
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

const EMPTY_DATA = { movers: [], losers: [], trending: [], as_of: null } as const;
const DATA_TIMEOUT_MS = 8_000; // under Vercel's 10s function limit
const AI_TIMEOUT_MS = 4_000;
const TRENDING_SET_PILLS = [
  "Prismatic Evolutions",
  "151",
  "Evolving Skies",
] as const;

type PopAlphaTier = "Trainer" | "Ace" | "Elite";

function getTierLabel(value: unknown): PopAlphaTier {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "elite") return "Elite";
  if (normalized === "ace") return "Ace";
  return "Trainer";
}

function getNarrativeHeading(tier: PopAlphaTier): string {
  if (tier === "Elite") return "PopAlpha Whale";
  if (tier === "Ace") return "PopAlpha Hunter";
  return "PopAlpha Scout";
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
      return "The tape is still building, but order flow looks spread out for now, which usually means conviction has not concentrated into a single set yet.";
    }
    if (tier === "Ace") {
      return "The board is still sorting itself out, and buyers look more rotational than committed to one clean pocket of momentum.";
    }
    return "I am still watching, but right now it looks like people are hopping around instead of all rushing into one obvious set.";
  }

  if ((rankedSets[0]?.[1] ?? 0) >= 3) {
    if (tier === "Elite") {
      return `${leader} is controlling the board right now, with the strongest recent action clustering there while capital keeps revisiting the same leadership pocket.`;
    }
    if (tier === "Ace") {
      return `${leader} is setting the pace today, and the strongest movers are stacking there in a way that looks more like focused conviction than random heat.`;
    }
    return `${leader} keeps showing up in the strongest cards today, which usually means collectors are all noticing the same hot pocket at once.`;
  }

  if (runnerUp) {
    if (tier === "Elite") {
      return `Leadership looks split between ${leader} and ${runnerUp}, which is usually what the board does when attention is broadening instead of compressing into one crowded trade.`;
    }
    if (tier === "Ace") {
      return `The board looks split between ${leader} and ${runnerUp}, which usually means buyers are widening out instead of forcing one overextended chase.`;
    }
    return `The action looks split between ${leader} and ${runnerUp}, so it does not feel like only one set is getting all the attention right now.`;
  }

  if (tier === "Elite") {
    return `${leader} has the cleanest leadership on the board right now, but the broader market still looks selective instead of running fully risk-on.`;
  }
  if (tier === "Ace") {
    return `${leader} has the cleanest momentum on the board right now, but the rest of the market still looks selective instead of overheated.`;
  }
  return `${leader} looks like the strongest set on the board right now, but the rest of the market still feels picky instead of way too hot.`;
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
    return `${leader.name} is still the card setting the tone right now, while ${trend.set_name ?? trend.name} keeps getting pulled along with it. At the same time, ${laggard.name} is clearly on the softer side of the board, so this does not feel like the whole market is ripping higher together. It feels more like collectors are being picky and putting their money into a few favorite spots instead of chasing everything at once.\n\n${communityLeader ? `${communityLeader.name} is also pulling about ${communityPct ?? 50}% bullish sentiment in Community Pulse, which tells us people are still leaning toward the stronger names.` : "The community vote still matters here because it helps show whether people are backing the same cards that are already holding up well."} That is usually a healthier setup than a totally overheated rush, but only if the cards getting the attention keep holding their prices once the excitement settles down a little.`;
  }

  if (leader) {
    return `${leader.name} is still the cleanest leader on the board, and that matters because the rest of the market does not look overheated yet. When one card keeps soaking up attention without everything else jumping with it, that usually means the demand is focused and real instead of just random hype.\n\n${communityLeader ? `Community Pulse is also leaning toward ${communityLeader.name}, which is a good sign if you want to see whether the crowd is backing real strength or just talking.` : "The next useful read is whether people keep backing the same leaders as more votes come in."} If that connection between price strength and collector interest starts to fade, the move can cool off faster than the headline number suggests.`;
  }

  if (trend) {
    return `${trend.set_name ?? trend.name} is still getting a lot of attention, but the board is thin enough that it does not feel crowded yet. Right now it looks more like the market is still deciding which cards deserve real conviction, instead of everyone piling into one obvious chase at the same time.\n\n${communityLeader ? `With ${communityLeader.name} still picking up community votes, the next thing to watch is whether that attention turns into stronger price action too.` : "The next thing to watch is whether all that attention actually turns into stronger prices."} If it does, the board can tighten up fast around a much clearer winner.`;
  }

  return "The board is still taking shape, but the strongest action is still pretty selective, which usually means the next clear mover has not fully broken out yet. Right now it feels more like collectors are circling a few interesting cards than committing hard to one big chase.\n\nCommunity Pulse still matters in that kind of setup because it can show where real conviction starts building first. The best thing to watch now is which cards keep holding attention, keep holding price, and keep pulling repeat votes at the same time.";
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
    return `${trimmed}\n\nThe board still looks worth watching, but the cleaner edge depends on where conviction keeps building next.`;
  }

  const midpoint = Math.ceil(sentences.length / 2);
  const first = sentences.slice(0, midpoint).join(" ").trim();
  const second = sentences.slice(midpoint).join(" ").trim();

  return `${first}\n\n${second || "The board still looks worth watching, but the cleaner edge depends on where conviction keeps building next."}`;
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
    return `${trimmed}\n\nThe cleanest edge still depends on whether the same cards keep pulling real money and real attention.\n\nIf that starts breaking apart, the board can cool off faster than it looks at first glance.`;
  }

  const chunkSize = Math.max(1, Math.ceil(sentences.length / 3));
  const first = sentences.slice(0, chunkSize).join(" ").trim();
  const second = sentences.slice(chunkSize, chunkSize * 2).join(" ").trim();
  const third = sentences.slice(chunkSize * 2).join(" ").trim();

  return `${first}\n\n${second || "The cleanest edge still depends on whether the same cards keep pulling real money and real attention."}\n\n${third || "If that starts breaking apart, the board can cool off faster than it looks at first glance."}`;
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
          "You are PopAlpha Ace Summary, an advanced market note for the homepage.",
          "Write like a smart, careful collector who really watches the market every day.",
          "Sound like a true collector first: grounded, observant, and easy to understand.",
          "Use layman's terms, but still communicate real market information clearly.",
          "Avoid stiff finance jargon unless it is truly necessary.",
          "Consider all available economic and sentiment signals, including movers, trending names, laggards, and community votes.",
          "Write exactly 2 paragraphs.",
          "Each paragraph should be multiple sentences, with real substance, not filler.",
          "The first paragraph should describe the strongest market action using the available price, trend, and rotation signals.",
          "The second paragraph should explain how community conviction, momentum, participation, liquidity, and risk line up or diverge.",
          "Make the reader feel like a knowledgeable collector is explaining what matters in plain English.",
          "Make the summary long and substantial enough that it reads like a genuine market note, not a caption.",
          "Do not mention being an AI, and do not invent metrics.",
        ].join(" "),
        prompt: [
          "Summarize the board using only the supplied homepage and community pulse data.",
          "Call out the strongest pocket of momentum and whether the crowd is reinforcing it or lagging it.",
          "Use all the supplied signals before reaching a conclusion.",
          "This should feel like real market insight for a serious user scanning the dashboard.",
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
    `What stands out first is the mood around the market, not just one card. Right now it feels like collectors are still reacting to the same mix of excitement, scarcity, and crowd psychology that shows up whenever a set gets hard to find and people start worrying they will miss the next big pull. That kind of environment usually makes the whole market feel louder, faster, and more emotional, even before you look at which names are actually leading.`,
    laggard
      ? `${leader ? `${leader.name} looks like one of the names getting the most serious attention right now, and ${runner ? `${runner.name} is helping widen that leadership pocket a bit.` : "the leadership still looks fairly narrow overall."}` : "The leadership still looks selective rather than broad."} At the same time, ${laggard.name} being softer is useful because it shows people are still choosing their spots instead of blindly chasing every chart that moves. That is usually healthier than a messy rush, but it also means the cards losing attention can cool off quickly if buyers keep narrowing down what they trust.`
      : `${leader ? `${leader.name} looks like one of the names getting the most serious attention right now, and that matters because the strongest money usually shows itself by staying concentrated instead of bouncing everywhere at once.` : "The strongest money still looks concentrated instead of scattered."} The softer parts of the board still matter because they show where conviction is not holding, and that helps separate real strength from noise.`,
    communityLeader
      ? `${communityLeader.name} is also pulling about ${bullishPct ?? 50}% bullish community sentiment, so the crowd is mostly lining up behind one of the names already getting real attention. When views, price strength, and community conviction all start pointing in the same direction, that is usually where the strongest follow-through shows up first. If one of those pieces drops away, the move can still lose steam faster than the headline prices suggest.`
      : "The next real signal is whether community conviction starts lining up with the same cards already holding price. When attention, pricing, and sentiment agree, the strongest moves usually become much easier to trust.",
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
          "You are PopAlpha Elite Summary, the highest-conviction market note on the homepage.",
          "Write like the sharpest collector in the room: calm, observant, and deeply informed.",
          "Use plain English, but make the insight feel premium and genuinely useful.",
          "Consider all supplied signals, including strength, weakness, rotation, community votes, and where conviction is clustering.",
          "Write at least 3 paragraphs.",
          "Each paragraph should have multiple sentences.",
          "Paragraph 1 should open with community insight and collector culture first, not a single card.",
          "Start by describing the mood of the hobby, the way people are reacting, and what that says about the marketplace.",
          "Paragraph 2 should explain where the strongest money and attention are concentrating, and what the weaker cards say about the health of the board.",
          "Paragraph 3 should explain how sentiment, follow-through, and risk line up from here.",
          "Do not open with one specific card name.",
          "Do not mention being an AI, and do not invent metrics.",
        ].join(" "),
        prompt: [
          "Use only the supplied homepage and community pulse data.",
          "Describe the board like a premium market read for serious collectors.",
          "Open with the culture around the market and how the community feels before narrowing into specific cards.",
          "Call out where conviction looks real, where it looks thin, and what would confirm or break the current move.",
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
      losers: data?.losers?.length ?? 0,
      trending: data?.trending?.length ?? 0,
    });
  } catch (err) {
    console.error("[homepage] getHomepageData threw:", err);
    data = EMPTY_DATA;
  }

  const movers = Array.isArray(data?.movers) ? data.movers : [];
  const losers = Array.isArray(data?.losers) ? data.losers : [];
  const trending = Array.isArray(data?.trending) ? data.trending : [];
  const asOf = timeAgo(data?.as_of ?? null);
  const userTier = getTierLabel(
    user?.publicMetadata.subscriptionTier ?? user?.publicMetadata.tier ?? user?.publicMetadata.plan,
  );
  const narrativeHeading = getNarrativeHeading(userTier);
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
          <div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">PopAlpha</h1>
            <p className="mt-1 text-[13px] text-[#555]">
              TCG Market Intelligence
              {asOf ? <span className="ml-2 text-[#444]">{asOf}</span> : null}
            </p>
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
                <span>Trending</span>
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
                {userTier === "Trainer" ? (
                  <p className="mt-1 text-[12px] font-medium tracking-[0.04em] text-emerald-200/85 sm:text-[13px]">
                  Pokémon-obsessed AI
                  </p>
                ) : null}
            </div>
            {userTier === "Trainer" ? (
              <span className="inline-flex h-[2.25rem] items-center gap-2 self-start rounded-full border border-red-500/20 bg-red-500/10 px-3 text-[18px] font-semibold leading-none tracking-[-0.01em] text-red-100">
                <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                  <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-red-500 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                </span>
                Live
              </span>
            ) : null}
          </div>
          <p
            className={[
              "relative z-10 mt-2 leading-relaxed",
              userTier === "Trainer" ? "text-[18px] font-medium text-emerald-50 sm:text-[19px]" : "text-base sm:text-[17px] text-[#D7DBE6]",
            ].join(" ")}
          >
            {marketNarrative}
          </p>
        </div>
      </div>

      {/* ── Top Movers ───────────────────────────────────────────────── */}
      <SectionCarousel title="Top Movers" icon="🔥" subtitle="7d">
        {movers.length > 0
          ? movers.slice(0, 5).map((card) => (
              <CardTileMini key={card.slug} card={card} showTier />
            ))
          : null}
        {movers.length === 0 ? (
          <EmptySlot message="No mover data yet" />
        ) : null}
      </SectionCarousel>
      <div className="mx-auto mt-6 max-w-5xl border-b border-white/5 px-4 sm:px-6 lg:px-0" />

      {/* ── Top Losers ───────────────────────────────────────────────── */}
      <SectionCarousel title="Biggest Drops" icon="📉" subtitle="7d trend">
        {losers.length > 0
          ? losers.slice(0, 5).map((card) => (
              <CardTileMini key={card.slug} card={card} />
            ))
          : null}
        {losers.length === 0 ? (
          <EmptySlot message="No drop data yet" />
        ) : null}
      </SectionCarousel>

      {/* ── Trending ─────────────────────────────────────────────────── */}
      <SectionCarousel title="Trending" icon="📈" subtitle="7d sustained">
        {trending.length > 0
          ? trending.slice(0, 5).map((card) => (
              <CardTileMini key={card.slug} card={card} />
            ))
          : null}
        {trending.length === 0 ? (
          <EmptySlot message="No trending data yet" />
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
                  Serious Collector with Serious Knowledge
                </p>
              </div>
              <span className="inline-flex h-[2.25rem] items-center gap-2 self-start rounded-full border border-red-500/20 bg-red-500/10 px-3 text-[18px] font-semibold leading-none tracking-[-0.01em] text-red-100">
                <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                  <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-red-500 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                </span>
                Live
              </span>
            </div>
            <div className="relative z-10 mt-2 text-[18px] font-medium leading-relaxed text-[#E5EEFF] sm:text-[19px]">
              <p>{acePreview.lead}</p>
              {acePreview.remainder ? (
                <div className="relative mt-2 overflow-hidden rounded-xl">
                  <p className="blur-[3px] select-none text-[#D9E8FF]/80">
                    {acePreview.remainder}
                  </p>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#60A5FA]/8 to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="inline-flex items-center justify-center rounded-full border border-blue-400/20 bg-[linear-gradient(135deg,rgba(96,165,250,0.95),rgba(59,130,246,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(59,130,246,0.28)]">
                      GO PREMIUM
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
        title="Breakout Candidates"
        icon="🧠"
        description="Unlock Pro to see breakout leaders"
      />

      {/* ── Undervalued vs Trend (PRO) ───────────────────────────────── */}
      <ProSectionLocked
        title="Undervalued Picks"
        icon="💎"
        description="Unlock Pro to see value-zone misalignment"
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
                  Highest Conviction Market Intelligence
                </p>
              </div>
              <span className="inline-flex h-[2.25rem] items-center gap-2 self-start rounded-full border border-red-500/20 bg-red-500/10 px-3 text-[18px] font-semibold leading-none tracking-[-0.01em] text-red-100">
                <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                  <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-red-500 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                </span>
                Live
              </span>
            </div>
            <div className="relative z-10 mt-2 text-[18px] font-medium leading-relaxed text-violet-50 sm:text-[19px]">
              <p>{elitePreview.lead}</p>
              {elitePreview.remainder ? (
                <div className="relative mt-2 overflow-hidden rounded-xl">
                  <p className="blur-[3px] select-none text-violet-100/80">
                    {elitePreview.remainder}
                  </p>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-violet-400/8 to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="inline-flex items-center justify-center rounded-full border border-violet-400/20 bg-[linear-gradient(135deg,rgba(139,92,246,0.95),rgba(99,102,241,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(99,102,241,0.28)]">
                      GO ELITE
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
          Most Viewed
        </h2>
        <span className="text-[14px] text-[#8A8A8A]">7d heat</span>
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
                High View Velocity
              </span>
              <div className="pointer-events-none absolute inset-0 rounded-[1.05rem] border border-white/[0.04]" />
            </div>
          ))}
        </div>

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="inline-flex items-center justify-center rounded-full border border-violet-400/20 bg-[linear-gradient(135deg,rgba(139,92,246,0.95),rgba(99,102,241,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(99,102,241,0.28)]">
            GO ELITE
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
      "I still think the market is crowding into the obvious chase cards a little too fast. The stronger move might be the names that are quietly holding price while everyone argues about the flashy stuff.",
  },
  {
    handle: "@HoloWatch",
    time: "27m ago",
    body:
      "Community sentiment feels way more confident this week, but that usually matters most when the same cards keep getting votes and keep getting added to watchlists. That is the part I am watching first.",
  },
] as const;

function BestPredictorsPlaceholderSection() {
  return (
    <section className="mt-8 lg:mx-auto lg:max-w-5xl lg:px-6">
      <div className="flex items-baseline gap-2 px-4 sm:px-6 lg:px-0">
        <span className="text-lg">🏆</span>
        <h2 className="text-[18px] font-semibold uppercase tracking-[0.06em] text-[#D4D4D8] sm:text-[20px]">
          Best Predictors
        </h2>
        <span className="text-[14px] text-[#8A8A8A]">weekly edge</span>
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
                  <p className="truncate text-[12px] text-zinc-500">Prediction Desk</p>
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
            GO ELITE
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
          Community Posts
        </h2>
        <span className="text-[14px] text-[#8A8A8A]">live chatter</span>
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
