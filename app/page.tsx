import { Suspense } from "react";
import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";
import { getHomepageData, type HomepageCard } from "@/lib/data/homepage";
import { getCommunityPulseSnapshot } from "@/lib/data/community-pulse";
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
    return "I am still watching the tape, but right now it looks like people are bouncing around instead of piling into one obvious set.";
  }

  if ((rankedSets[0]?.[1] ?? 0) >= 3) {
    if (tier === "Elite") {
      return `${leader} is controlling the board right now, with the strongest recent action clustering there while capital keeps revisiting the same leadership pocket.`;
    }
    if (tier === "Ace") {
      return `${leader} is setting the pace today, and the strongest movers are stacking there in a way that looks more like focused conviction than random heat.`;
    }
    return `${leader} keeps showing up across the strongest movers today, which feels like everyone noticed the same chase pocket at once.`;
  }

  if (runnerUp) {
    if (tier === "Elite") {
      return `Leadership looks split between ${leader} and ${runnerUp}, which is usually what the board does when attention is broadening instead of compressing into one crowded trade.`;
    }
    if (tier === "Ace") {
      return `The board looks split between ${leader} and ${runnerUp}, which usually means buyers are widening out instead of forcing one overextended chase.`;
    }
    return `The action looks split between ${leader} and ${runnerUp}, so it does not feel like just one set is stealing all the oxygen right now.`;
  }

  if (tier === "Elite") {
    return `${leader} has the cleanest leadership on the board right now, but the broader market still looks selective instead of running fully risk-on.`;
  }
  if (tier === "Ace") {
    return `${leader} has the cleanest momentum on the board right now, but the rest of the market still looks selective instead of overheated.`;
  }
  return `${leader} looks like the cleanest set on the board right now, but the rest of the market still feels picky instead of totally overheated.`;
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
            "mt-4 rounded-2xl px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-xl",
            userTier === "Trainer"
              ? "border border-[#63D471]/25 bg-[linear-gradient(180deg,rgba(99,212,113,0.10),rgba(255,255,255,0.03))]"
              : "border border-white/[0.06] bg-white/[0.03]",
          ].join(" ")}
        >
          <div className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] ${narrativeAccent}`}>
            <span
              className={[
                "inline-flex h-2 w-2 rounded-full",
                userTier === "Trainer"
                  ? "bg-[#63D471] shadow-[0_0_12px_rgba(99,212,113,0.9)]"
                  : userTier === "Ace"
                    ? "bg-[#C7D2FE] shadow-[0_0_12px_rgba(199,210,254,0.7)]"
                    : "bg-[#8FBFFF] shadow-[0_0_12px_rgba(143,191,255,0.8)]",
              ].join(" ")}
            />
            {narrativeHeading}
          </div>
          <p className="mt-2 text-sm leading-6 text-[#D7DBE6]">
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
      <section className="mt-8">
        <div className="flex items-baseline gap-2 px-4 sm:px-6">
          <span className="text-base">🗳</span>
          <h2 className="text-[15px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">
            Community Pulse
          </h2>
        </div>
        <div className="mt-3 px-4 sm:px-6">
          <CommunityPulseBoard
            cards={communityPulse.cards}
            votesRemaining={communityPulse.votesRemaining}
            weeklyLimit={communityPulse.weeklyLimit}
            weekEndsAt={communityPulse.weekEndsAt}
            signedIn={!!user}
          />
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
