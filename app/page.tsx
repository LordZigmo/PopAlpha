import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import { getHomepageData, type HomepageCard } from "@/lib/data/homepage";
import HomepageSearch from "@/components/homepage-search";
import TypewriterText from "@/components/typewriter-text";
import HomepageMobileNav from "@/components/homepage-mobile-nav";
import { Search, ArrowRight, Activity, TrendingUp } from "lucide-react";

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

function formatPrice(n: number | null): string {
  if (n == null || n <= 0) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
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
  prices_refreshed_today: 0,
} as const;

const DATA_TIMEOUT_MS = 8_000;

type PopAlphaTier = "Trainer" | "Ace" | "Elite";

function getTierLabel(value: unknown): PopAlphaTier {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "elite") return "Elite";
  if (normalized === "ace") return "Ace";
  return "Trainer";
}

const HOMEPAGE_SCOUT_NARRATIVE =
  "The Pokémon market still looks selective, with attention clustering around a few chase names instead of spreading across the whole board. That usually means collector conviction is real, but still narrow, so the next read is whether confidence starts widening into deeper cards and sealed.";

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

function deriveSignalChips(
  movers: HomepageCard[],
  losers: HomepageCard[],
  trending: HomepageCard[],
): string[] {
  const chips: string[] = [];
  const allCards = [...movers, ...trending, ...losers];
  const uniqueSets = new Set(allCards.map((c) => c.set_name).filter(Boolean));
  if (uniqueSets.size <= 2) chips.push("Narrow breadth");
  else if (uniqueSets.size >= 5) chips.push("Broad rotation");
  const highConf = movers.filter((c) => c.confidence_score != null && c.confidence_score >= 80);
  if (highConf.length >= 3) chips.push("Strong conviction");
  else if (movers.length > 0 && highConf.length <= 1) chips.push("Conviction building");
  if (movers.length > 0 && losers.length === 0) chips.push("Clean sweep up");
  else if (losers.length > movers.length) chips.push("Pressure building");
  const topMover = movers[0];
  if (topMover && topMover.change_pct != null && topMover.change_pct > 15) {
    chips.push("Chase-led market");
  }
  if (trending.length >= 4) chips.push("Sustained momentum");
  return chips.slice(0, 3);
}

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
  const pricesRefreshed = data?.prices_refreshed_today ?? 0;

  return (
    <div className="hp-root min-h-screen bg-[#050505] text-[#F0F0F0]">
      {/* ── Nav ──────────────────────────────────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-50 bg-[#050505]/60 backdrop-blur-2xl">
        <div className="mx-auto flex h-[60px] max-w-[1200px] items-center justify-between px-6 sm:px-10">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/brand/popalpha-icon-transparent.svg"
              alt="PopAlpha"
              width={26}
              height={26}
              className="h-[26px] w-[26px]"
            />
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-white">PopAlpha</span>
          </Link>
          <nav className="flex items-center gap-6">
            <Link href="/search" className="hidden text-[13px] text-[#666] transition hover:text-white sm:block">
              Search
            </Link>
            <Link href="/sets" className="hidden text-[13px] text-[#666] transition hover:text-white sm:block">
              Sets
            </Link>
            <Link href="/portfolio" className="hidden text-[13px] text-[#666] transition hover:text-white sm:block">
              Portfolio
            </Link>
            {!user ? (
              <Link
                href="/sign-in"
                className="rounded-full bg-white px-4 py-1.5 text-[13px] font-medium text-[#0A0A0A] transition hover:bg-[#e0e0e0]"
              >
                Sign in
              </Link>
            ) : null}
          </nav>
        </div>
      </header>

      {/* ══════════════════════════════════════════════════════════════
          SECTION 1 — HERO
          ══════════════════════════════════════════════════════════════ */}
      <section className="relative overflow-hidden">
        {/* Background glow */}
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{
            background:
              "radial-gradient(ellipse 70% 50% at 50% -5%, rgba(0,180,216,0.06) 0%, transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-[1200px] px-6 pt-32 pb-8 sm:px-10 sm:pt-40 sm:pb-12 lg:pt-44 lg:pb-16">
          {/* Headline */}
          <div className="max-w-[680px]">
            <h1 className="text-[clamp(2rem,5.5vw,3.5rem)] font-bold leading-[1.05] tracking-[-0.035em] text-white">
              See what&apos;s moving
              <br />
              <span className="hp-headline-accent">before the market does</span>
            </h1>
            <p className="mt-5 max-w-[520px] text-[16px] leading-[1.65] text-[#888] sm:text-[17px]">
              Track real price action, confidence, and collector momentum across raw, sealed, and graded cards.
            </p>

            {/* CTAs */}
            <div className="mt-8 flex flex-wrap items-center gap-3.5">
              <Link
                href="/sign-up"
                className="hp-btn-primary inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-[14px] font-semibold"
              >
                Start free
                <ArrowRight size={14} strokeWidth={2.5} />
              </Link>
              <Link
                href="/search"
                className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] px-6 py-2.5 text-[14px] font-medium text-[#ccc] transition hover:border-white/[0.16] hover:text-white"
              >
                Explore live market
              </Link>
            </div>

            {/* Search */}
            <div className="mt-10 max-w-[540px]">
              <Suspense
                fallback={
                  <div className="flex h-[48px] items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4">
                    <Search size={16} className="text-[#555]" />
                    <span className="text-[14px] text-[#555]">Start with a pokemon...</span>
                  </div>
                }
              >
                <HomepageSearch />
              </Suspense>
            </div>
          </div>

          {/* Live terminal — desktop */}
          <div className="mt-12 lg:absolute lg:right-10 lg:top-36 lg:mt-0 lg:w-[400px]">
            <div className="hp-terminal overflow-hidden rounded-2xl border border-white/[0.06]">
              {/* Terminal header */}
              <div className="flex items-center justify-between border-b border-white/[0.04] bg-white/[0.015] px-5 py-3">
                <div className="flex items-center gap-2">
                  <Activity size={13} className="text-cyan-400" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
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

              {/* Top movers preview */}
              {highConfidenceMovers.length > 0 ? (
                <div className="bg-[#080808]">
                  <div className="px-5 pt-3 pb-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#555]">Top movers</span>
                  </div>
                  {highConfidenceMovers.slice(0, 4).map((card, i) => {
                    const confScore = card.confidence_score;
                    const confColor = confScore != null
                      ? confScore >= 85 ? "#63D471" : confScore >= 70 ? "#7DD3FC" : confScore >= 55 ? "#FACC15" : "#FF8A80"
                      : "#555";
                    return (
                      <Link
                        key={card.slug}
                        href={`/c/${encodeURIComponent(card.slug)}`}
                        className="group flex items-center gap-3 border-b border-white/[0.03] px-5 py-2.5 transition hover:bg-white/[0.02] last:border-b-0"
                      >
                        <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-[#444]">{i + 1}</span>
                        {card.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={card.image_url} alt="" className="h-9 w-[26px] shrink-0 rounded-[4px] object-cover" />
                        ) : (
                          <div className="h-9 w-[26px] shrink-0 rounded-[4px] bg-white/[0.04]" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-[#ddd] group-hover:text-white">{card.name}</p>
                          <p className="truncate text-[10px] text-[#444]">{card.set_name ?? "—"}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2.5">
                          {confScore != null ? (
                            <div className="flex gap-[2px]">
                              {Array.from({ length: 4 }, (_, idx) => {
                                const filled = confScore >= 85 ? 4 : confScore >= 70 ? 3 : confScore >= 55 ? 2 : 1;
                                return (
                                  <span
                                    key={idx}
                                    className="h-[3px] w-[8px] rounded-full"
                                    style={{ backgroundColor: idx < filled ? confColor : "rgba(255,255,255,0.06)" }}
                                  />
                                );
                              })}
                            </div>
                          ) : null}
                          <span
                            className="text-[13px] font-semibold tabular-nums"
                            style={{ color: (card.change_pct ?? 0) > 0 ? "#00DC5A" : (card.change_pct ?? 0) < 0 ? "#FF3B30" : "#666" }}
                          >
                            {formatPct(card.change_pct)}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              ) : null}

              {/* AI brief snippet */}
              <div className="border-t border-white/[0.04] bg-[#080808] px-5 py-3">
                <div className="flex items-center gap-2">
                  <Image src="/brand/popalpha-icon-transparent.svg" alt="" width={16} height={16} className="h-4 w-4 opacity-70" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#555]">Scout Brief</span>
                </div>
                <p className="mt-1.5 text-[12px] leading-[1.6] text-[#888] line-clamp-2">
                  {takeaway}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          SECTION 2 — PROOF STRIP
          ══════════════════════════════════════════════════════════════ */}
      <section className="border-y border-white/[0.04]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-center gap-x-12 gap-y-4 px-6 py-5 sm:px-10 sm:py-6">
          <ProofItem value="10,000+" label="Cards tracked" />
          <ProofItem value="Raw · Sealed · Graded" label="Full coverage" plain />
          <ProofItem value={pricesRefreshed > 0 ? pricesRefreshed.toLocaleString() : "Live"} label="Prices refreshed" />
          <ProofItem value="AI" label="Market reads" />
          <ProofItem value="Scored" label="Confidence" />
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          SECTION 3 — WHY POPALPHA
          ══════════════════════════════════════════════════════════════ */}
      <section className="mx-auto max-w-[1200px] px-6 pt-20 pb-8 sm:px-10 sm:pt-28 sm:pb-12">
        <div className="max-w-[480px]">
          <h2 className="text-[clamp(1.5rem,3.5vw,2.25rem)] font-bold leading-[1.1] tracking-[-0.03em] text-white">
            The collector&apos;s edge
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-[#777]">
            Not just prices. Context, conviction, and signal.
          </p>
        </div>

        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-white/[0.04] sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard
            accent="#00B4D8"
            title="Instant card intelligence"
            description="Search or scan any card. Get live pricing, trend data, and market context in seconds."
          />
          <FeatureCard
            accent="#00DC5A"
            title="AI market reads"
            description="Daily AI-generated briefs on what is moving, why it matters, and where conviction is concentrating."
          />
          <FeatureCard
            accent="#A78BFA"
            title="Confidence scoring"
            description="Every price signal comes with a confidence score, so you know which moves to trust and which to watch."
          />
          <FeatureCard
            accent="#F59E0B"
            title="Portfolio tracking"
            description="Track your collection value, set completion, and watchlist across raw, sealed, and graded."
          />
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          SECTION 4 — LIVE MARKET PROOF
          ══════════════════════════════════════════════════════════════ */}
      {highConfidenceMovers.length > 0 || trending.length > 0 || losers.length > 0 ? (
        <section className="mx-auto max-w-[1200px] px-6 pt-12 pb-8 sm:px-10 sm:pt-20 sm:pb-12">
          <div className="flex items-end justify-between gap-4">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-400/80">Live market</span>
              <h2 className="mt-1 text-[clamp(1.4rem,3vw,2rem)] font-bold tracking-[-0.03em] text-white">
                What&apos;s moving right now
              </h2>
            </div>
            {asOf ? (
              <span className="hidden text-[11px] text-[#444] sm:block">Updated {asOf}</span>
            ) : null}
          </div>

          {/* ── High-Confidence Movers ─── */}
          {highConfidenceMovers.length > 0 ? (
            <div className="mt-8">
              <div className="flex items-center gap-2.5 pb-4">
                <h3 className="text-[14px] font-semibold text-[#ccc]">High-Confidence Movers</h3>
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                  24H
                </span>
              </div>

              {/* Table header */}
              <div className="hidden border-b border-white/[0.06] pb-2.5 sm:grid sm:grid-cols-[minmax(0,1fr)_100px_100px_110px_80px] sm:gap-4 sm:px-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#444]">Card</span>
                <span className="text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-[#444]">Price</span>
                <span className="text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-[#444]">Change</span>
                <span className="text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-[#444]">Confidence</span>
                <span className="text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-[#444]">Signal</span>
              </div>

              {/* Rows */}
              {highConfidenceMovers.slice(0, 5).map((card, i) => (
                <MoverRow key={card.slug} card={card} rank={i + 1} />
              ))}
            </div>
          ) : null}

          {/* ── Trending + Drops side-by-side ─── */}
          {trending.length > 0 || losers.length > 0 ? (
            <div className="mt-14 grid gap-8 lg:grid-cols-2">
              {/* Trending */}
              {trending.length > 0 ? (
                <div>
                  <div className="flex items-center gap-2.5 pb-4">
                    <TrendingUp size={14} className="text-cyan-400" />
                    <h3 className="text-[14px] font-semibold text-[#ccc]">Trending</h3>
                    <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
                      7D
                    </span>
                  </div>
                  <div className="space-y-px overflow-hidden rounded-xl border border-white/[0.04]">
                    {trending.slice(0, 5).map((card) => (
                      <CompactRow key={card.slug} card={card} direction="up" />
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Biggest Drops */}
              {losers.length > 0 ? (
                <div>
                  <div className="flex items-center gap-2.5 pb-4">
                    <TrendingUp size={14} className="rotate-180 text-red-400" />
                    <h3 className="text-[14px] font-semibold text-[#ccc]">Biggest Drops</h3>
                    <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400">
                      24H
                    </span>
                  </div>
                  <div className="space-y-px overflow-hidden rounded-xl border border-white/[0.04]">
                    {losers.slice(0, 5).map((card) => (
                      <CompactRow key={card.slug} card={card} direction="down" />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ══════════════════════════════════════════════════════════════
          SECTION 5 — AI MARKET BRIEF
          ══════════════════════════════════════════════════════════════ */}
      <section className="mx-auto max-w-[1200px] px-6 pt-12 pb-8 sm:px-10 sm:pt-20 sm:pb-12">
        <div className="max-w-[480px]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-400/80">PopAlpha Scout</span>
          <h2 className="mt-1 text-[clamp(1.4rem,3vw,2rem)] font-bold tracking-[-0.03em] text-white">
            Daily reads on where conviction is building
          </h2>
        </div>

        <div className="hp-scout-card mt-8 relative overflow-hidden rounded-2xl border border-emerald-500/10 bg-[#080808]">
          {/* Subtle accent line */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
            aria-hidden="true"
            style={{ background: "linear-gradient(180deg, #00B4D8, #00DC5A)" }}
          />

          <div className="px-6 py-6 sm:px-8 sm:py-8">
            {/* Header */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Image
                  src="/brand/popalpha-icon-transparent.svg"
                  alt=""
                  width={24}
                  height={24}
                  className="h-6 w-6"
                />
                <div>
                  <span className="text-[13px] font-semibold text-white">AI Market Brief</span>
                  <span className="ml-2 text-[11px] text-[#555]">{asOf || "Live"}</span>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/8 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                Live
              </span>
            </div>

            {/* Key takeaway */}
            <div className="mt-5 rounded-xl border border-white/[0.04] bg-white/[0.02] px-5 py-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#555]">Key takeaway</p>
              <p className="mt-1 text-[15px] font-medium leading-snug text-white">{takeaway}</p>
            </div>

            {/* Narrative */}
            <div className="mt-4">
              <TypewriterText
                text={narrative}
                className="text-[14px] leading-[1.7] text-[#999]"
              />
            </div>

            {/* Signal chips */}
            {signalChips.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {signalChips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded-full border border-white/[0.05] bg-white/[0.02] px-2.5 py-0.5 text-[11px] font-medium text-[#777]"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            ) : null}

            {/* CTA */}
            {userTier === "Trainer" ? (
              <div className="mt-5 border-t border-white/[0.04] pt-4">
                <Link
                  href="/sign-up"
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium text-cyan-400 transition hover:text-white"
                >
                  Unlock deeper market reads
                  <ArrowRight size={13} />
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          SECTION 6 — FINAL CTA
          ══════════════════════════════════════════════════════════════ */}
      {!user ? (
        <section className="mx-auto max-w-[1200px] px-6 pt-12 pb-20 sm:px-10 sm:pt-20 sm:pb-28">
          <div className="hp-cta relative overflow-hidden rounded-3xl border border-white/[0.04]">
            {/* Background gradient */}
            <div
              className="pointer-events-none absolute inset-0"
              aria-hidden="true"
              style={{
                background:
                  "radial-gradient(ellipse 60% 80% at 50% 120%, rgba(0,180,216,0.06) 0%, transparent 60%)",
              }}
            />
            <div className="relative px-8 py-14 text-center sm:px-16 sm:py-20">
              <h2 className="text-[clamp(1.5rem,3.5vw,2.25rem)] font-bold leading-[1.1] tracking-[-0.03em] text-white">
                Start tracking the market
                <br />
                <span className="text-[#666]">with an edge</span>
              </h2>
              <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-[#777]">
                Free to search, scan, and explore. Upgrade for deeper intelligence.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3.5">
                <Link
                  href="/sign-up"
                  className="hp-btn-primary inline-flex items-center gap-2 rounded-full px-7 py-3 text-[14px] font-semibold"
                >
                  Get started free
                  <ArrowRight size={14} strokeWidth={2.5} />
                </Link>
                <Link
                  href="/search"
                  className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] px-7 py-3 text-[14px] font-medium text-[#ccc] transition hover:border-white/[0.16] hover:text-white"
                >
                  View live market
                </Link>
              </div>
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

/* ── Sub-components ──────────────────────────────────────────────── */

function ProofItem({ value, label, plain }: { value: string; label: string; plain?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`text-[14px] font-semibold tabular-nums ${plain ? "text-[#888]" : "text-white"}`}>
        {value}
      </span>
      <span className="text-[11px] text-[#555]">{label}</span>
    </div>
  );
}

function FeatureCard({ accent, title, description }: { accent: string; title: string; description: string }) {
  return (
    <div className="group border-r border-b border-white/[0.04] bg-[#080808] p-6 transition last:border-r-0 hover:bg-[#0C0C0C] sm:p-8">
      <div
        className="mb-4 h-[3px] w-8 rounded-full opacity-70"
        style={{ backgroundColor: accent }}
      />
      <h3 className="text-[15px] font-semibold text-white">{title}</h3>
      <p className="mt-2 text-[13px] leading-[1.6] text-[#666]">{description}</p>
    </div>
  );
}

function MoverRow({ card, rank }: { card: HomepageCard; rank: number }) {
  const confScore = card.confidence_score;
  const confColor = confScore != null
    ? confScore >= 85 ? "#63D471" : confScore >= 70 ? "#7DD3FC" : confScore >= 55 ? "#FACC15" : "#FF8A80"
    : "#555";

  return (
    <Link
      href={`/c/${encodeURIComponent(card.slug)}`}
      className="group flex items-center gap-4 border-b border-white/[0.03] px-3 py-3.5 transition hover:bg-white/[0.015] last:border-b-0 sm:grid sm:grid-cols-[minmax(0,1fr)_100px_100px_110px_80px]"
    >
      {/* Card identity */}
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-initial">
        <span className="w-5 shrink-0 text-center text-[12px] tabular-nums text-[#444]">{rank}</span>
        {card.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.image_url} alt="" className="h-10 w-7 shrink-0 rounded-[4px] object-cover" />
        ) : (
          <div className="h-10 w-7 shrink-0 rounded-[4px] bg-white/[0.04]" />
        )}
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-[#eee] group-hover:text-white">{card.name}</p>
          <p className="truncate text-[11px] text-[#444]">{card.set_name ?? "—"}</p>
        </div>
      </div>

      {/* Price */}
      <span className="hidden text-right text-[13px] font-medium tabular-nums text-[#999] sm:block">
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
      <div className="hidden items-center justify-end gap-2 sm:flex">
        {confScore != null ? (
          <>
            <div className="flex gap-[2px]">
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
            <span className="text-[11px] font-medium tabular-nums" style={{ color: confColor }}>{confScore}</span>
          </>
        ) : (
          <span className="text-[11px] text-[#444]">—</span>
        )}
      </div>

      {/* Signal */}
      <div className="hidden justify-end sm:flex">
        {card.mover_tier === "hot" ? (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
            Hot
          </span>
        ) : card.mover_tier === "warming" ? (
          <span className="rounded-full bg-amber-500/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
            Warming
          </span>
        ) : (
          <span className="text-[11px] text-[#444]">—</span>
        )}
      </div>
    </Link>
  );
}

function CompactRow({ card, direction }: { card: HomepageCard; direction: "up" | "down" }) {
  const changeColor = direction === "up" ? "#00DC5A" : "#FF3B30";
  return (
    <Link
      href={`/c/${encodeURIComponent(card.slug)}`}
      className="group flex items-center justify-between gap-3 bg-[#080808] px-5 py-3 transition hover:bg-[#0C0C0C]"
    >
      <div className="flex min-w-0 items-center gap-3">
        {card.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.image_url} alt="" className="h-8 w-6 shrink-0 rounded-[3px] object-cover" />
        ) : (
          <div className="h-8 w-6 shrink-0 rounded-[3px] bg-white/[0.04]" />
        )}
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-[#ccc] group-hover:text-white">{card.name}</p>
          <p className="truncate text-[10px] text-[#444]">{card.set_name ?? "—"}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-[12px] tabular-nums text-[#666]">{formatPrice(card.market_price)}</span>
        <span className="text-[13px] font-semibold tabular-nums" style={{ color: changeColor }}>
          {formatPct(card.change_pct)}
        </span>
      </div>
    </Link>
  );
}
