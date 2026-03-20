import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import { getHomepageData, type HomepageCard } from "@/lib/data/homepage";
import HomepageSearch from "@/components/homepage-search";
import CardTileMini from "@/components/card-tile-mini";
import TypewriterText from "@/components/typewriter-text";
import HomepageMobileNav from "@/components/homepage-mobile-nav";
import { Search, TrendingUp, ArrowRight } from "lucide-react";

export const dynamic = "force-dynamic";

/* ── helpers ──────────────────────────────────────────────────────── */

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

const DATA_TIMEOUT_MS = 8_000;

const TRENDING_SET_PILLS = [
  "Prismatic Evolutions",
  "151",
  "Evolving Skies",
] as const;

const HOMEPAGE_SCOUT_NARRATIVE =
  "The Pokémon market still looks selective, with attention clustering around a few chase names instead of spreading across the whole board. That usually means collector conviction is real, but still narrow, so the next read is whether confidence starts widening into deeper cards and sealed.";

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
    return "The board is still building. Conviction has not concentrated into a single set yet — collectors are rotating instead of committing.";
  }
  if ((rankedSets[0]?.[1] ?? 0) >= 3) {
    return `${leader} is controlling the board right now, with the strongest action clustering there while capital keeps revisiting the same leadership pocket.`;
  }
  if (runnerUp) {
    return `Leadership looks split between ${leader} and ${runnerUp} — attention is broadening instead of compressing into one crowded trade.`;
  }
  return `${leader} has the cleanest momentum on the board right now, but the rest of the market still looks selective instead of overheated.`;
}

/* ── page ─────────────────────────────────────────────────────────── */

export default async function HomePage() {
  let user: Awaited<ReturnType<typeof import("@clerk/nextjs/server").currentUser>> | null = null;
  if (clerkEnabled) {
    const { currentUser } = await import("@clerk/nextjs/server");
    user = await currentUser();
  }
  let data;
  try {
    data = await Promise.race([
      getHomepageData(),
      new Promise<typeof EMPTY_DATA>((resolve) =>
        setTimeout(() => resolve(EMPTY_DATA), DATA_TIMEOUT_MS),
      ),
    ]);
  } catch {
    data = EMPTY_DATA;
  }

  const highConfidenceMovers = Array.isArray(data?.high_confidence_movers) ? data.high_confidence_movers : [];
  const movers = Array.isArray(data?.movers) ? data.movers : [];
  const losers = Array.isArray(data?.losers) ? data.losers : [];
  const trending = Array.isArray(data?.trending) ? data.trending : [];
  const asOf = timeAgo(data?.as_of ?? null);
  const userTier = getTierLabel(
    user?.publicMetadata.subscriptionTier ?? user?.publicMetadata.tier ?? user?.publicMetadata.plan,
  );
  const narrative =
    userTier === "Trainer"
      ? HOMEPAGE_SCOUT_NARRATIVE
      : buildMarketNarrative(userTier, movers, losers, trending);

  return (
    <div className="homepage-root min-h-screen bg-[#0A0A0A] text-[#F0F0F0]">
      {/* ── Nav ──────────────────────────────────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-50 bg-[#0A0A0A]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="text-[17px] font-bold tracking-tight text-white">
            PopAlpha
          </Link>
          <nav className="flex items-center gap-5">
            <Link
              href="/sets"
              className="hidden text-[13px] font-medium text-[#888] transition hover:text-white sm:block"
            >
              Sets
            </Link>
            <Link
              href="/portfolio"
              className="hidden text-[13px] font-medium text-[#888] transition hover:text-white sm:block"
            >
              Portfolio
            </Link>
            <Link
              href="/about"
              className="hidden text-[13px] font-medium text-[#888] transition hover:text-white sm:block"
            >
              About
            </Link>
            {!user ? (
              <Link
                href="/sign-in"
                className="ml-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.1]"
              >
                Sign in
              </Link>
            ) : null}
          </nav>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden pt-32 pb-6 sm:pt-40 sm:pb-10">
        {/* Subtle radial glow behind hero */}
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{
            background:
              "radial-gradient(ellipse 70% 50% at 50% 20%, rgba(0,180,216,0.06) 0%, transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-3xl px-5 text-center sm:px-8">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-3.5 py-1.5 text-[12px] font-medium text-[#999] backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            Live market data
            {asOf ? <span className="text-[#666]">{asOf}</span> : null}
          </p>

          <h1 className="text-[clamp(2rem,5vw,3.5rem)] font-bold leading-[1.08] tracking-tight text-white">
            Market intelligence
            <br />
            <span className="bg-gradient-to-r from-[#7dd3fc] to-[#a5b4fc] bg-clip-text text-transparent">for collectors</span>
          </h1>

          <p className="mx-auto mt-5 max-w-lg text-[15px] leading-relaxed text-[#777] sm:text-[16px]">
            Track prices, spot movers, and follow conviction.
            The AI layer that helps you see what the market sees.
          </p>

          {/* Search surface */}
          <div className="mt-8 sm:mt-10">
            <div className="homepage-search-wrap mx-auto max-w-xl rounded-2xl border border-white/[0.08] bg-[#111]/80 p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.4)] backdrop-blur-xl transition-all focus-within:border-white/[0.14] focus-within:shadow-[0_20px_60px_rgba(0,0,0,0.5),0_0_0_1px_rgba(0,180,216,0.15)]">
              <Suspense
                fallback={
                  <div className="flex h-[52px] items-center gap-3 rounded-xl bg-white/[0.03] px-4">
                    <Search size={18} className="text-[#555]" />
                    <span className="text-[14px] text-[#555]">Search cards...</span>
                  </div>
                }
              >
                <HomepageSearch />
              </Suspense>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <span className="text-[12px] font-medium text-[#555]">Trending</span>
              {TRENDING_SET_PILLS.map((setName) => (
                <Link
                  key={setName}
                  href={`/search?q=${encodeURIComponent(setName)}`}
                  className="rounded-full border border-white/[0.05] px-3 py-1 text-[12px] font-medium text-[#777] transition hover:border-white/[0.1] hover:text-white"
                >
                  {setName}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── AI Market Brief ──────────────────────────────────────── */}
      <section className="mx-auto max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
        <div className="homepage-brief relative overflow-hidden rounded-2xl border border-white/[0.06] bg-[#111]/60 px-6 py-6 backdrop-blur-sm sm:px-8 sm:py-8">
          {/* Shimmer accent */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 w-[2px] rounded-full"
            style={{ background: "linear-gradient(180deg, #00B4D8, #00DC5A)" }}
          />

          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
                <TrendingUp size={16} className="text-emerald-400" />
              </div>
              <div>
                <h2 className="text-[14px] font-semibold tracking-tight text-white">
                  AI Market Brief
                </h2>
                <p className="text-[11px] text-[#666]">PopAlpha Scout</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/15 bg-emerald-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-emerald-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              Live
            </span>
          </div>

          <div className="mt-5">
            <TypewriterText
              text={narrative}
              className="text-[15px] leading-[1.7] text-[#ccc] sm:text-[16px]"
            />
          </div>

          {userTier === "Trainer" ? (
            <div className="mt-6 flex items-center gap-3 border-t border-white/[0.05] pt-5">
              <Link
                href="/sign-up"
                className="inline-flex items-center gap-2 text-[13px] font-medium text-[#00B4D8] transition hover:text-white"
              >
                Unlock deeper market reads
                <ArrowRight size={14} />
              </Link>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── High-Confidence Movers ───────────────────────────────── */}
      {highConfidenceMovers.length > 0 ? (
        <section className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h2 className="text-[22px] font-bold tracking-tight text-white sm:text-[26px]">
                High-Confidence Movers
              </h2>
              <p className="mt-1 text-[13px] text-[#666]">
                24h gains with strong price confidence
                {asOf ? <span className="ml-2 text-[#555]">{asOf}</span> : null}
              </p>
            </div>
          </div>

          <div
            className="mt-6 flex gap-4 overflow-x-auto pb-2 sm:gap-5 lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0"
            style={{
              scrollSnapType: "x mandatory",
              WebkitOverflowScrolling: "touch",
              scrollbarWidth: "none",
            }}
          >
            {highConfidenceMovers.slice(0, 5).map((card) => (
              <CardTileMini key={card.slug} card={card} showTier />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Trending ─────────────────────────────────────────────── */}
      {trending.length > 0 ? (
        <section className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
          <div className="mb-6 border-t border-white/[0.04] pt-6 sm:pt-10">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <h2 className="text-[20px] font-bold tracking-tight text-white sm:text-[22px]">
                  Trending
                </h2>
                <p className="mt-1 text-[13px] text-[#666]">
                  7-day sustained momentum
                </p>
              </div>
            </div>

            <div
              className="mt-6 flex gap-4 overflow-x-auto pb-2 sm:gap-5 lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0"
              style={{
                scrollSnapType: "x mandatory",
                WebkitOverflowScrolling: "touch",
                scrollbarWidth: "none",
              }}
            >
              {trending.slice(0, 5).map((card) => (
                <CardTileMini key={card.slug} card={card} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Biggest Drops ────────────────────────────────────────── */}
      {losers.length > 0 ? (
        <section className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
          <div className="mb-6 border-t border-white/[0.04] pt-6 sm:pt-10">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <h2 className="text-[20px] font-bold tracking-tight text-white sm:text-[22px]">
                  Biggest Drops
                </h2>
                <p className="mt-1 text-[13px] text-[#666]">
                  7-day price declines worth watching
                </p>
              </div>
            </div>

            <div
              className="mt-6 flex gap-4 overflow-x-auto pb-2 sm:gap-5 lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0"
              style={{
                scrollSnapType: "x mandatory",
                WebkitOverflowScrolling: "touch",
                scrollbarWidth: "none",
              }}
            >
              {losers.slice(0, 5).map((card) => (
                <CardTileMini key={card.slug} card={card} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Value Proposition ────────────────────────────────────── */}
      <section className="mx-auto max-w-4xl px-5 py-12 sm:px-8 sm:py-20">
        <div className="border-t border-white/[0.04] pt-12 sm:pt-20">
          <div className="text-center">
            <h2 className="text-[22px] font-bold tracking-tight text-white sm:text-[28px]">
              Why collectors use PopAlpha
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] text-[#777]">
              Real market signal. Not noise, not guesses.
            </p>
          </div>

          <div className="mt-10 grid gap-6 sm:mt-14 sm:grid-cols-3 sm:gap-8">
            <div className="rounded-xl border border-white/[0.04] bg-white/[0.02] p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00B4D8]/10 text-[#00B4D8]">
                <Search size={18} />
              </div>
              <h3 className="mt-4 text-[15px] font-semibold text-white">
                Instant card intelligence
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[#777]">
                Search or scan any card and get live pricing, trend data, and market context in seconds.
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.04] bg-white/[0.02] p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                <TrendingUp size={18} />
              </div>
              <h3 className="mt-4 text-[15px] font-semibold text-white">
                AI-powered market reads
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[#777]">
                Daily AI market briefs that explain what is moving, why it matters, and where conviction is building.
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.04] bg-white/[0.02] p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400">
                <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <h3 className="mt-4 text-[15px] font-semibold text-white">
                Portfolio tracking
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[#777]">
                Track your collection value, set completion, and watchlist — all in one place.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────── */}
      {!user ? (
        <section className="mx-auto max-w-3xl px-5 pb-20 sm:px-8 sm:pb-28">
          <div className="homepage-cta-card relative overflow-hidden rounded-2xl border border-white/[0.06] bg-[#111]/40 px-6 py-10 text-center sm:px-10 sm:py-14">
            <div
              className="pointer-events-none absolute inset-0"
              aria-hidden="true"
              style={{
                background:
                  "radial-gradient(ellipse 60% 60% at 50% 100%, rgba(0,180,216,0.04) 0%, transparent 60%)",
              }}
            />
            <h2 className="relative text-[20px] font-bold tracking-tight text-white sm:text-[24px]">
              Start tracking the market
            </h2>
            <p className="relative mx-auto mt-3 max-w-sm text-[14px] text-[#777]">
              Free to search, scan, and explore. Upgrade for deeper intelligence.
            </p>
            <div className="relative mt-6">
              <Link
                href="/sign-up"
                className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-[14px] font-semibold text-[#0A0A0A] transition hover:bg-white/90"
              >
                Get started
                <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Mobile Nav ───────────────────────────────────────────── */}
      <div className="pb-24 md:pb-0" />
      <HomepageMobileNav />
    </div>
  );
}
