import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import { getHomepageData, type HomepageCard } from "@/lib/data/homepage";
import HomepageSearch from "@/components/homepage-search";
import TypewriterText from "@/components/typewriter-text";
import HomepageMobileNav from "@/components/homepage-mobile-nav";
import { Search, TrendingUp, ArrowRight, Activity, BarChart3, Layers, Eye, Zap, Shield } from "lucide-react";

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

function formatPrice(n: number | null): string {
  if (n == null || n <= 0) return "--";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "--";
  const abs = Math.abs(n);
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)}%`;
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

/** Derive signal chips from market data */
function deriveSignalChips(
  movers: HomepageCard[],
  losers: HomepageCard[],
  trending: HomepageCard[],
): string[] {
  const chips: string[] = [];
  const allCards = [...movers, ...trending, ...losers];

  // Market breadth
  const uniqueSets = new Set(allCards.map((c) => c.set_name).filter(Boolean));
  if (uniqueSets.size <= 2) chips.push("Narrow breadth");
  else if (uniqueSets.size >= 5) chips.push("Broad rotation");

  // Chase concentration
  const highConf = movers.filter((c) => c.confidence_score != null && c.confidence_score >= 80);
  if (highConf.length >= 3) chips.push("Strong conviction");
  else if (movers.length > 0 && highConf.length <= 1) chips.push("Conviction building");

  // Mover vs loser balance
  if (movers.length > 0 && losers.length === 0) chips.push("Clean sweep up");
  else if (losers.length > movers.length) chips.push("Pressure building");

  // Chase-led
  const topMover = movers[0];
  if (topMover && topMover.change_pct != null && topMover.change_pct > 15) {
    chips.push("Chase-led market");
  }

  // Trending momentum
  if (trending.length >= 4) chips.push("Sustained momentum");

  return chips.slice(0, 3);
}

/** Derive one-line takeaway from data */
function deriveTakeaway(movers: HomepageCard[], losers: HomepageCard[]): string {
  if (movers.length === 0 && losers.length === 0) return "Market is quiet — no strong signals right now.";
  const topMover = movers[0];
  if (topMover && topMover.change_pct != null && topMover.change_pct > 10) {
    return `${topMover.name} is leading today's action at ${formatPct(topMover.change_pct)}.`;
  }
  if (movers.length > losers.length) {
    return `${movers.length} high-confidence movers versus ${losers.length} drops — buyers have the edge.`;
  }
  return `Mixed signals with ${movers.length} gainers and ${losers.length} decliners on the board.`;
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

  const signalChips = deriveSignalChips(highConfidenceMovers, losers, trending);
  const takeaway = deriveTakeaway(highConfidenceMovers, losers);

  // Proof metrics
  const totalCards = new Set([
    ...highConfidenceMovers.map((c) => c.slug),
    ...movers.map((c) => c.slug),
    ...losers.map((c) => c.slug),
    ...trending.map((c) => c.slug),
  ]).size;
  const activeSets = new Set([
    ...highConfidenceMovers.map((c) => c.set_name),
    ...movers.map((c) => c.set_name),
    ...losers.map((c) => c.set_name),
    ...trending.map((c) => c.set_name),
  ].filter(Boolean)).size;

  return (
    <div className="homepage-root min-h-screen bg-[#0A0A0A] text-[#F0F0F0]">
      {/* ── Nav ──────────────────────────────────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.04] bg-[#0A0A0A]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="text-[16px] font-bold tracking-tight text-white">
            PopAlpha
          </Link>
          <nav className="flex items-center gap-5">
            <Link
              href="/sets"
              className="hidden text-[13px] font-medium text-[#666] transition hover:text-white sm:block"
            >
              Sets
            </Link>
            <Link
              href="/portfolio"
              className="hidden text-[13px] font-medium text-[#666] transition hover:text-white sm:block"
            >
              Portfolio
            </Link>
            <Link
              href="/about"
              className="hidden text-[13px] font-medium text-[#666] transition hover:text-white sm:block"
            >
              About
            </Link>
            {!user ? (
              <Link
                href="/sign-in"
                className="ml-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-white/[0.08]"
              >
                Sign in
              </Link>
            ) : null}
          </nav>
        </div>
      </header>

      {/* ── Hero: Command Surface ─────────────────────────────────── */}
      <section className="relative overflow-hidden pt-24 pb-4 sm:pt-28 sm:pb-6">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{
            background:
              "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(0,180,216,0.04) 0%, transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-7xl px-5 sm:px-8">
          {/* Split hero: headline left, live signal right */}
          <div className="grid items-start gap-8 lg:grid-cols-[1fr_380px] lg:gap-12">
            {/* Left: headline + search */}
            <div className="max-w-2xl pt-2">
              <div className="flex items-start gap-4 sm:gap-5">
                <Image
                  src="/brand/popalpha-icon-transparent.svg"
                  alt="PopAlpha logo"
                  width={64}
                  height={64}
                  className="mt-1 hidden shrink-0 sm:block"
                />
                <h1 className="text-[clamp(1.75rem,4.5vw,2.75rem)] font-bold leading-[1.1] tracking-tight text-white">
                  Live market intelligence
                  <br />
                  <span className="text-[#666]">for Pokémon collectors</span>
                </h1>
              </div>

              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-[#888]">
                Track prices, spot conviction, and follow meaningful movement. AI-powered signal across raw, sealed, and graded.
              </p>

              {/* Search surface */}
              <div className="mt-6 sm:mt-8">
                <div className="homepage-search-wrap max-w-xl rounded-xl border border-white/[0.08] bg-[#111]/80 p-1 shadow-[0_12px_40px_rgba(0,0,0,0.3)] backdrop-blur-xl transition-all focus-within:border-white/[0.14] focus-within:shadow-[0_12px_40px_rgba(0,0,0,0.4),0_0_0_1px_rgba(0,180,216,0.12)]">
                  <Suspense
                    fallback={
                      <div className="flex h-[48px] items-center gap-3 rounded-lg bg-white/[0.03] px-4">
                        <Search size={16} className="text-[#555]" />
                        <span className="text-[14px] text-[#555]">Search cards...</span>
                      </div>
                    }
                  >
                    <HomepageSearch />
                  </Suspense>
                </div>

                {/* Product loop hint */}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-[#555]">
                    <Search size={11} className="text-[#444]" />
                    <span>Search or scan</span>
                  </div>
                  <span className="text-[#333]">→</span>
                  <div className="flex items-center gap-1.5 text-[11px] text-[#555]">
                    <Activity size={11} className="text-[#444]" />
                    <span>See signal</span>
                  </div>
                  <span className="text-[#333]">→</span>
                  <div className="flex items-center gap-1.5 text-[11px] text-[#555]">
                    <Eye size={11} className="text-[#444]" />
                    <span>Follow</span>
                  </div>
                  <span className="text-[#333]">→</span>
                  <div className="flex items-center gap-1.5 text-[11px] text-[#555]">
                    <Zap size={11} className="text-[#444]" />
                    <span>Get updates</span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-widest text-[#444]">Trending</span>
                  {TRENDING_SET_PILLS.map((setName) => (
                    <Link
                      key={setName}
                      href={`/search?q=${encodeURIComponent(setName)}`}
                      className="rounded-md border border-white/[0.05] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-[#666] transition hover:border-white/[0.1] hover:text-white"
                    >
                      {setName}
                    </Link>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: Live signal panel */}
            <div className="hidden rounded-xl border border-white/[0.06] bg-[#0E0E0E] lg:block">
              {/* Panel header */}
              <div className="flex items-center justify-between border-b border-white/[0.04] px-5 py-3">
                <div className="flex items-center gap-2">
                  <Activity size={13} className="text-emerald-400" />
                  <span className="text-[12px] font-semibold uppercase tracking-widest text-[#888]">
                    Market Pulse
                  </span>
                </div>
                <span className="flex items-center gap-1.5 text-[11px] text-[#555]">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </span>
                  {asOf || "Live"}
                </span>
              </div>

              {/* Proof metrics */}
              <div className="grid grid-cols-2 gap-px border-b border-white/[0.04] bg-white/[0.02]">
                <div className="bg-[#0E0E0E] px-5 py-3.5">
                  <span className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Cards tracked</span>
                  <p className="mt-0.5 text-[20px] font-bold tabular-nums text-white">10,000+</p>
                </div>
                <div className="bg-[#0E0E0E] px-5 py-3.5">
                  <span className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Sets covered</span>
                  <p className="mt-0.5 text-[20px] font-bold tabular-nums text-white">{activeSets > 0 ? `${activeSets}+` : "50+"}</p>
                </div>
                <div className="bg-[#0E0E0E] px-5 py-3.5">
                  <span className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Signals today</span>
                  <p className="mt-0.5 text-[20px] font-bold tabular-nums text-white">{totalCards > 0 ? totalCards : "--"}</p>
                </div>
                <div className="bg-[#0E0E0E] px-5 py-3.5">
                  <span className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Coverage</span>
                  <p className="mt-0.5 text-[13px] font-semibold text-[#ccc]">Raw · Sealed · Graded</p>
                </div>
              </div>

              {/* Top movers preview */}
              {highConfidenceMovers.length > 0 ? (
                <div className="px-5 py-3">
                  <span className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Top movers now</span>
                  <div className="mt-2 space-y-2">
                    {highConfidenceMovers.slice(0, 3).map((card) => (
                      <Link
                        key={card.slug}
                        href={`/c/${encodeURIComponent(card.slug)}`}
                        className="group flex items-center justify-between gap-3"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          {card.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={card.image_url}
                              alt=""
                              className="h-8 w-6 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <div className="h-8 w-6 shrink-0 rounded bg-white/[0.04]" />
                          )}
                          <span className="truncate text-[13px] font-medium text-[#ccc] group-hover:text-white">
                            {card.name}
                          </span>
                        </div>
                        <span
                          className="shrink-0 text-[13px] font-semibold tabular-nums"
                          style={{ color: (card.change_pct ?? 0) > 0 ? "#00DC5A" : (card.change_pct ?? 0) < 0 ? "#FF3B30" : "#666" }}
                        >
                          {formatPct(card.change_pct)}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* ── AI Market Brief ──────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-5 py-6 sm:px-8 sm:py-8">
        <div className="homepage-brief relative overflow-hidden rounded-xl border border-white/[0.06] bg-[#0E0E0E]">
          {/* Accent bar */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
            style={{ background: "linear-gradient(180deg, #00B4D8, #00DC5A)" }}
          />

          <div className="px-5 py-4 sm:px-6 sm:py-5">
            {/* Brief header */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Image
                  src="/brand/popalpha-icon.svg"
                  alt=""
                  width={28}
                  height={28}
                  className="rounded-md"
                />
                <div>
                  <h2 className="text-[13px] font-semibold tracking-tight text-white">
                    AI Market Brief
                  </h2>
                  <p className="text-[11px] text-[#555]">
                    PopAlpha Scout · {asOf || "Live"}
                  </p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/10 bg-emerald-500/[0.04] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                Live
              </span>
            </div>

            {/* Takeaway */}
            <div className="mt-4 rounded-lg border border-white/[0.04] bg-white/[0.02] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-[#555]">Key takeaway</p>
              <p className="mt-1 text-[14px] font-medium leading-snug text-white">
                {takeaway}
              </p>
            </div>

            {/* Narrative */}
            <div className="mt-3">
              <TypewriterText
                text={narrative}
                className="text-[14px] leading-[1.7] text-[#999]"
              />
            </div>

            {/* Signal chips */}
            {signalChips.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {signalChips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[11px] font-medium text-[#888]"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            ) : null}

            {userTier === "Trainer" ? (
              <div className="mt-4 flex items-center gap-3 border-t border-white/[0.04] pt-3">
                <Link
                  href="/sign-up"
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#00B4D8] transition hover:text-white"
                >
                  Unlock deeper market reads
                  <ArrowRight size={12} />
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* ── High-Confidence Movers (Leaderboard) ──────────────────── */}
      {highConfidenceMovers.length > 0 ? (
        <section className="mx-auto max-w-7xl px-5 py-6 sm:px-8 sm:py-8">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-[20px] font-bold tracking-tight text-white sm:text-[22px]">
                  High-Confidence Movers
                </h2>
                <span className="rounded-md border border-emerald-500/15 bg-emerald-500/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                  24H
                </span>
              </div>
              <p className="mt-1 text-[12px] text-[#555]">
                Strongest gains backed by price confidence and liquidity
              </p>
            </div>
            {asOf ? (
              <span className="hidden text-[11px] text-[#444] sm:block">Updated {asOf}</span>
            ) : null}
          </div>

          {/* Leaderboard table */}
          <div className="mt-5 overflow-hidden rounded-xl border border-white/[0.06] bg-[#0E0E0E]">
            {/* Table header */}
            <div className="hidden border-b border-white/[0.04] px-5 py-2.5 sm:grid sm:grid-cols-[minmax(0,1fr)_100px_100px_100px_90px] sm:items-center sm:gap-4">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-[#444]">Card</span>
              <span className="text-right text-[10px] font-semibold uppercase tracking-widest text-[#444]">Price</span>
              <span className="text-right text-[10px] font-semibold uppercase tracking-widest text-[#444]">Change</span>
              <span className="text-right text-[10px] font-semibold uppercase tracking-widest text-[#444]">Confidence</span>
              <span className="text-right text-[10px] font-semibold uppercase tracking-widest text-[#444]">Signal</span>
            </div>

            {/* Rows */}
            {highConfidenceMovers.slice(0, 5).map((card, i) => {
              const confScore = card.confidence_score;
              const confLabel = confScore != null
                ? confScore >= 85 ? "High" : confScore >= 70 ? "Solid" : confScore >= 55 ? "Watch" : "Low"
                : null;
              const confColor = confScore != null
                ? confScore >= 85 ? "#63D471" : confScore >= 70 ? "#7DD3FC" : confScore >= 55 ? "#FACC15" : "#FF8A80"
                : "#555";

              return (
                <Link
                  key={card.slug}
                  href={`/c/${encodeURIComponent(card.slug)}`}
                  className="group flex items-center gap-4 border-b border-white/[0.03] px-5 py-3.5 transition hover:bg-white/[0.02] last:border-b-0 sm:grid sm:grid-cols-[minmax(0,1fr)_100px_100px_100px_90px]"
                >
                  {/* Card identity */}
                  <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-initial">
                    <span className="w-5 shrink-0 text-center text-[12px] font-medium tabular-nums text-[#444]">
                      {i + 1}
                    </span>
                    {card.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={card.image_url}
                        alt=""
                        className="h-10 w-7 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="h-10 w-7 shrink-0 rounded bg-white/[0.04]" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-[#eee] group-hover:text-white">
                        {card.name}
                      </p>
                      <p className="truncate text-[11px] text-[#555]">{card.set_name ?? "—"}</p>
                    </div>
                  </div>

                  {/* Price */}
                  <span className="hidden text-right text-[13px] font-semibold tabular-nums text-[#ccc] sm:block">
                    {formatPrice(card.market_price)}
                  </span>

                  {/* Change */}
                  <span
                    className="shrink-0 text-right text-[13px] font-bold tabular-nums sm:block"
                    style={{ color: (card.change_pct ?? 0) > 0 ? "#00DC5A" : (card.change_pct ?? 0) < 0 ? "#FF3B30" : "#666" }}
                  >
                    {formatPct(card.change_pct)}
                  </span>

                  {/* Confidence */}
                  <div className="hidden items-center justify-end gap-1.5 sm:flex">
                    {confScore != null ? (
                      <>
                        <div className="flex gap-0.5">
                          {Array.from({ length: 4 }, (_, idx) => {
                            const filled = confScore >= 85 ? 4 : confScore >= 70 ? 3 : confScore >= 55 ? 2 : 1;
                            return (
                              <span
                                key={idx}
                                className="h-1 w-3 rounded-full"
                                style={{ backgroundColor: idx < filled ? confColor : "rgba(255,255,255,0.06)" }}
                              />
                            );
                          })}
                        </div>
                        <span className="text-[11px] font-medium tabular-nums" style={{ color: confColor }}>
                          {confScore}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-[#444]">—</span>
                    )}
                  </div>

                  {/* Signal tier */}
                  <div className="hidden justify-end sm:flex">
                    {card.mover_tier === "hot" ? (
                      <span className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                        Hot
                      </span>
                    ) : card.mover_tier === "warming" ? (
                      <span className="rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                        Warming
                      </span>
                    ) : (
                      <span className="text-[11px] text-[#444]">—</span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ── Trending + Drops: side-by-side ────────────────────────── */}
      {trending.length > 0 || losers.length > 0 ? (
        <section className="mx-auto max-w-7xl px-5 py-6 sm:px-8 sm:py-8">
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Trending */}
            {trending.length > 0 ? (
              <div className="rounded-xl border border-white/[0.06] bg-[#0E0E0E]">
                <div className="flex items-center justify-between border-b border-white/[0.04] px-5 py-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp size={14} className="text-[#7DD3FC]" />
                    <h3 className="text-[14px] font-semibold text-white">Trending</h3>
                    <span className="rounded-md border border-sky-500/15 bg-sky-500/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
                      7D
                    </span>
                  </div>
                  <span className="text-[11px] text-[#444]">Sustained momentum</span>
                </div>
                <div className="divide-y divide-white/[0.03]">
                  {trending.slice(0, 5).map((card) => (
                    <Link
                      key={card.slug}
                      href={`/c/${encodeURIComponent(card.slug)}`}
                      className="group flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-white/[0.02]"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        {card.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={card.image_url} alt="" className="h-8 w-6 shrink-0 rounded object-cover" />
                        ) : (
                          <div className="h-8 w-6 shrink-0 rounded bg-white/[0.04]" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-[#ccc] group-hover:text-white">{card.name}</p>
                          <p className="truncate text-[11px] text-[#444]">{card.set_name ?? "—"}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-[12px] font-medium tabular-nums text-[#888]">{formatPrice(card.market_price)}</span>
                        <span
                          className="text-[13px] font-semibold tabular-nums"
                          style={{ color: (card.change_pct ?? 0) > 0 ? "#00DC5A" : "#666" }}
                        >
                          {formatPct(card.change_pct)}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Biggest Drops */}
            {losers.length > 0 ? (
              <div className="rounded-xl border border-white/[0.06] bg-[#0E0E0E]">
                <div className="flex items-center justify-between border-b border-white/[0.04] px-5 py-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp size={14} className="rotate-180 text-[#FF6B6B]" />
                    <h3 className="text-[14px] font-semibold text-white">Biggest Drops</h3>
                    <span className="rounded-md border border-red-500/15 bg-red-500/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400">
                      24H
                    </span>
                  </div>
                  <span className="text-[11px] text-[#444]">Declines worth watching</span>
                </div>
                <div className="divide-y divide-white/[0.03]">
                  {losers.slice(0, 5).map((card) => (
                    <Link
                      key={card.slug}
                      href={`/c/${encodeURIComponent(card.slug)}`}
                      className="group flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-white/[0.02]"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        {card.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={card.image_url} alt="" className="h-8 w-6 shrink-0 rounded object-cover" />
                        ) : (
                          <div className="h-8 w-6 shrink-0 rounded bg-white/[0.04]" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-[#ccc] group-hover:text-white">{card.name}</p>
                          <p className="truncate text-[11px] text-[#444]">{card.set_name ?? "—"}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-[12px] font-medium tabular-nums text-[#888]">{formatPrice(card.market_price)}</span>
                        <span
                          className="text-[13px] font-semibold tabular-nums"
                          style={{ color: (card.change_pct ?? 0) < 0 ? "#FF3B30" : "#666" }}
                        >
                          {formatPct(card.change_pct)}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Why PopAlpha ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <div className="border-t border-white/[0.04] pt-10 sm:pt-14">
          <div className="mb-8">
            <h2 className="text-[18px] font-bold tracking-tight text-white sm:text-[20px]">
              The collector&apos;s edge
            </h2>
            <p className="mt-1 text-[13px] text-[#666]">
              Real market signal. Not noise, not guesses, not hype.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-white/[0.04] bg-white/[0.015] p-5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#00B4D8]/8">
                <Search size={15} className="text-[#00B4D8]" />
              </div>
              <h3 className="mt-3 text-[13px] font-semibold text-white">
                Instant card intelligence
              </h3>
              <p className="mt-1.5 text-[12px] leading-relaxed text-[#666]">
                Search or scan any card. Get live pricing, trend data, and market context in seconds.
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.04] bg-white/[0.015] p-5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/8">
                <BarChart3 size={15} className="text-emerald-400" />
              </div>
              <h3 className="mt-3 text-[13px] font-semibold text-white">
                AI market reads
              </h3>
              <p className="mt-1.5 text-[12px] leading-relaxed text-[#666]">
                Daily AI-generated briefs on what is moving, why it matters, and where conviction is concentrating.
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.04] bg-white/[0.015] p-5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/8">
                <Shield size={15} className="text-violet-400" />
              </div>
              <h3 className="mt-3 text-[13px] font-semibold text-white">
                Confidence scoring
              </h3>
              <p className="mt-1.5 text-[12px] leading-relaxed text-[#666]">
                Every price signal comes with a confidence score, so you know which moves to trust and which to watch.
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.04] bg-white/[0.015] p-5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/8">
                <Layers size={15} className="text-amber-400" />
              </div>
              <h3 className="mt-3 text-[13px] font-semibold text-white">
                Portfolio tracking
              </h3>
              <p className="mt-1.5 text-[12px] leading-relaxed text-[#666]">
                Track your collection value, set completion, and watchlist across raw, sealed, and graded.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────── */}
      {!user ? (
        <section className="mx-auto max-w-7xl px-5 pb-16 sm:px-8 sm:pb-24">
          <div className="homepage-cta-card relative overflow-hidden rounded-xl border border-white/[0.06] bg-[#0E0E0E] px-6 py-10 sm:px-10 sm:py-12">
            <div
              className="pointer-events-none absolute inset-0"
              aria-hidden="true"
              style={{
                background:
                  "radial-gradient(ellipse 50% 60% at 50% 100%, rgba(0,180,216,0.03) 0%, transparent 60%)",
              }}
            />
            <div className="relative flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
              <div>
                <h2 className="text-[18px] font-bold tracking-tight text-white sm:text-[20px]">
                  Start tracking the market
                </h2>
                <p className="mt-1 text-[13px] text-[#666]">
                  Free to search, scan, and explore. Upgrade for deeper intelligence.
                </p>
              </div>
              <Link
                href="/sign-up"
                className="homepage-cta-btn inline-flex shrink-0 items-center gap-2 rounded-lg px-5 py-2.5 text-[13px] font-semibold"
              >
                Get started free
                <ArrowRight size={14} />
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
