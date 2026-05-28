import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, BookOpen, House, Layers3, Search } from "lucide-react";
import CanonicalCardShell from "@/components/layout/CanonicalCardShell";
import {
  getJapaneseCatalogState,
  getPipelineStatus,
  getTierSummary,
  type JapaneseCatalogState,
  type PipelineStatus,
  type RefreshTier,
  type TierSummary,
} from "@/lib/data/tier-summary";

const title = "Data | PopAlpha";
const description = "How we price every Pokemon card — and how we tell you when we don't know.";
const canonicalPath = "/data";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: canonicalPath },
  openGraph: {
    title,
    description,
    url: canonicalPath,
    siteName: "PopAlpha",
    type: "website",
    images: [{ url: "/opengraph-image", alt: "PopAlpha" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/twitter-image"],
  },
};

export const dynamic = "force-dynamic";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

const TIER_COPY: Record<RefreshTier, { title: string; trade: string; show: string; dotClass: string }> = {
  hot: {
    title: "Hot",
    trade: "Trade actively, often every day. The fast-moving end of the catalog.",
    show: "Live price with a 24-hour change badge.",
    dotClass: "bg-[#F87171]",
  },
  warm: {
    title: "Warm",
    trade: "Trade most weeks, several days a month. The trading-active core.",
    show: "Recent price, refreshed every day or two.",
    dotClass: "bg-[#FBBF24]",
  },
  sparse: {
    title: "Sparse",
    trade: "Trade once or twice a month. Real cards, real owners — just illiquid.",
    show: "\"Last sold $X · Apr 28\" — exact date of the most recent sale.",
    dotClass: "bg-[#60A5FA]",
  },
  dormant: {
    title: "Dormant",
    trade: "Have not traded in 6+ months. The deep tail of the catalog.",
    show: "\"No recent market\" instead of a stale, misleading price.",
    dotClass: "bg-[#6B7280]",
  },
};

const STATUS_COPY: Record<PipelineStatus["state"], { label: string; description: string; tone: string }> = {
  live: {
    label: "Live",
    description: "Today's homepage rails are computed and the pipeline is current.",
    tone: "text-[#4ADE80] border-[#14532D] bg-[#052E16]",
  },
  catching_up: {
    label: "Catching up",
    description: "Today's rails haven't been computed yet. The next refresh will pick it up.",
    tone: "text-[#FBBF24] border-[#78350F] bg-[#1C1917]",
  },
  stale: {
    label: "Stale",
    description: "Rails haven't refreshed in more than a day. We're investigating.",
    tone: "text-[#F87171] border-[#7F1D1D] bg-[#2A0F12]",
  },
  unknown: {
    label: "Unknown",
    description: "We haven't computed homepage rails yet.",
    tone: "text-[#9CA3AF] border-[#374151] bg-[#0F1115]",
  },
};

function StatusPill({ status }: { status: PipelineStatus }) {
  const copy = STATUS_COPY[status.state];
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${copy.tone}`}>
      <span className="inline-flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.14em]">
        <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
        {copy.label}
      </span>
      <span className="text-[14px] text-[#D1D5DB]">{copy.description}</span>
      {status.latestRailsComputedAt ? (
        <span className="text-[12px] text-[#9CA3AF]">
          Last refresh: {formatRelativeTime(status.latestRailsComputedAt)}
        </span>
      ) : null}
    </div>
  );
}

function TierCard({ entry, copy }: { entry: TierSummary["tiers"][number]; copy: typeof TIER_COPY[RefreshTier] }) {
  return (
    <article className="rounded-2xl border border-[#1E1E1E] bg-[#0D0D0D] p-5 sm:p-6">
      <div className="flex items-baseline gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${copy.dotClass}`} aria-hidden="true" />
        <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-white sm:text-[20px]">{copy.title}</h3>
      </div>
      <p className="mt-4 text-[34px] font-semibold leading-none tracking-[-0.04em] text-white sm:text-[40px]">
        {formatNumber(entry.count)}
      </p>
      <p className="mt-1 text-[13px] text-[#8B8B8B]">
        {formatPct(entry.pct)} of the catalog
      </p>
      <p className="mt-4 text-[14px] leading-6 text-[#C9CDD3]">
        {copy.trade}
      </p>
      <div className="mt-4 rounded-xl border border-[#1F1F1F] bg-[#0A0A0A] p-3">
        <p className="text-[11px] uppercase tracking-[0.14em] text-[#6B7280]">What you see</p>
        <p className="mt-1 text-[13px] leading-5 text-[#D1D5DB]">{copy.show}</p>
      </div>
    </article>
  );
}

type RailLink = { href: string; label: string; icon: typeof House };

function RailAction({ href, label, icon: Icon }: RailLink) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-[1.1rem] border border-transparent bg-transparent px-4 py-3 text-[#B0B0B0] transition hover:border-white/[0.05] hover:bg-white/[0.03] hover:text-white"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-[0.9rem] border border-[#1E1E1E] bg-[#0B0B0B] text-[#6B7280]">
        <Icon size={18} strokeWidth={2.1} />
      </span>
      <span className="text-[15px] font-semibold">{label}</span>
    </Link>
  );
}

function SectionJump({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="flex items-center justify-between rounded-[1rem] border border-[#1E1E1E] bg-[#0B0B0B] px-3 py-3 text-[13px] font-medium text-[#B0B0B0] transition hover:border-white/[0.06] hover:text-white"
    >
      <span>{label}</span>
      <ArrowRight size={14} />
    </a>
  );
}

export default async function DataPage() {
  const [tierResult, pipelineResult, japaneseResult] = await Promise.allSettled([
    getTierSummary(),
    getPipelineStatus(),
    getJapaneseCatalogState(),
  ]);

  if (tierResult.status === "rejected") {
    console.error("[data/page] failed to load tier summary:",
      tierResult.reason instanceof Error ? tierResult.reason.message : String(tierResult.reason));
  }
  if (pipelineResult.status === "rejected") {
    console.error("[data/page] failed to load pipeline status:",
      pipelineResult.reason instanceof Error ? pipelineResult.reason.message : String(pipelineResult.reason));
  }
  if (japaneseResult.status === "rejected") {
    console.error("[data/page] failed to load Japanese catalog state:",
      japaneseResult.reason instanceof Error ? japaneseResult.reason.message : String(japaneseResult.reason));
  }

  const tierSummary = tierResult.status === "fulfilled" ? tierResult.value : null;
  const pipelineStatus = pipelineResult.status === "fulfilled" ? pipelineResult.value : null;
  const japanese: JapaneseCatalogState | null = japaneseResult.status === "fulfilled" ? japaneseResult.value : null;

  const totalCards = tierSummary?.total ?? 0;
  const hotCount = tierSummary?.tiers.find((t) => t.tier === "hot")?.count ?? 0;
  const hotPct = tierSummary?.tiers.find((t) => t.tier === "hot")?.pct ?? 0;
  const tradeRarelyPct = tierSummary
    ? tierSummary.tiers
        .filter((t) => t.tier !== "hot")
        .reduce((sum, t) => sum + t.pct, 0)
    : 0;

  const quickActions: RailLink[] = [
    { href: "/", label: "Home", icon: House },
    { href: "/search", label: "Search", icon: Search },
    { href: "/sets", label: "Sets", icon: BookOpen },
    { href: "/portfolio", label: "Portfolio", icon: Layers3 },
  ];
  const pageLinks = [
    { href: "#tiers", label: "The Four Tiers" },
    { href: "#truth", label: "The Honest Take" },
    { href: "#japanese", label: "Japanese Catalog" },
    { href: "#contribute", label: "Shape the Market" },
    { href: "#methodology", label: "How We Compute This" },
  ];

  const contextRail = (
    <div className="px-5 py-6">
      <section className="rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Catalog</p>
        <p className="mt-3 text-[28px] font-semibold leading-none tracking-[-0.04em] text-white">
          {tierSummary ? formatNumber(totalCards) : "—"}
        </p>
        <p className="mt-1 text-[13px] text-[#8B8B8B]">Pokemon cards we track</p>

        {tierSummary ? (
          <div className="mt-5 space-y-2">
            {tierSummary.tiers.map((entry) => {
              const copy = TIER_COPY[entry.tier];
              return (
                <div key={entry.tier} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-[12px] text-[#C9CDD3]">
                    <span className={`h-2 w-2 rounded-full ${copy.dotClass}`} aria-hidden="true" />
                    {copy.title}
                  </span>
                  <span className="text-[12px] tabular-nums text-[#9CA3AF]">
                    {formatPct(entry.pct)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-4">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Quick Actions</p>
        <div className="mt-3 space-y-1.5">
          {quickActions.map((link) => (
            <RailAction key={`${link.label}-${link.href}`} {...link} />
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-4">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">On Page</p>
        <div className="mt-3 space-y-2">
          {pageLinks.map((link) => (
            <SectionJump key={link.href} {...link} />
          ))}
        </div>
      </section>
    </div>
  );

  return (
    <CanonicalCardShell backHref="/" rightRail={contextRail}>
      <div className="mx-auto max-w-5xl px-4 pb-[max(env(safe-area-inset-bottom),2.5rem)] pt-8 sm:px-6 sm:pb-[max(env(safe-area-inset-bottom),3.5rem)]">
        <div className="space-y-6">
          <section className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
              Data
            </p>
            <h1 className="mt-3 text-[28px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[44px]">
              How we price every Pokemon card
            </h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-[#A8AEB6] sm:text-[16px]">
              {tierSummary ? (
                <>We track <span className="text-white">{formatNumber(totalCards)}</span> cards. Most don't trade every day — and we don't pretend they do. Here's what we know about each card and how confident we are.</>
              ) : (
                <>We track every Pokemon card we can find. Most don't trade every day — and we don't pretend they do. Here's what we know about each card and how confident we are.</>
              )}
            </p>

            {pipelineStatus ? (
              <div className="mt-6">
                <StatusPill status={pipelineStatus} />
              </div>
            ) : null}
          </section>

          <section id="tiers" className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
              The Four Tiers
            </p>
            <h2 className="mt-3 text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">
              Every card has a confidence level
            </h2>
            <p className="mt-3 max-w-2xl text-[14px] leading-6 text-[#9CA3AF]">
              We sort the catalog by how often each card actually trades. Active cards get fresh, live prices. Quiet cards get an honest "last sold" date. We never invent a number that isn't real.
            </p>

            {tierSummary ? (
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                {tierSummary.tiers.map((entry) => (
                  <TierCard key={entry.tier} entry={entry} copy={TIER_COPY[entry.tier]} />
                ))}
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border border-[#78350F] bg-[#1C1917] p-5">
                <p className="text-[12px] uppercase tracking-[0.14em] text-[#FBBF24]">Temporarily Unavailable</p>
                <p className="mt-2 text-[15px] text-[#D1D5DB]">
                  Tier counts could not be loaded right now. Refresh in a moment.
                </p>
              </div>
            )}
          </section>

          {tierSummary ? (
            <section id="truth" className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
                The Honest Take
              </p>
              <p className="mt-4 text-[20px] font-medium leading-8 tracking-[-0.01em] text-white sm:text-[24px] sm:leading-9">
                Only <span className="text-[#F87171]">{formatPct(hotPct)}</span> of Pokemon cards trade actively enough to need a daily refresh.
              </p>
              <p className="mt-3 text-[15px] leading-7 text-[#A8AEB6]">
                The other <span className="text-white">{formatPct(tradeRarelyPct)}</span> trade infrequently — sometimes once a month, sometimes once a year, sometimes never. That's not a limitation of our pipeline. That's the Pokemon card market.
              </p>
              <p className="mt-3 text-[15px] leading-7 text-[#A8AEB6]">
                Other apps paper over this with stale numbers that look fresh. We tell you exactly when each card last sold, and we say "no recent market" when there isn't one. Pricing you can trust starts with pricing you can verify.
              </p>
            </section>
          ) : null}

          <section id="japanese" className="rounded-[28px] border border-[#3F1212] bg-gradient-to-br from-[#1A0A0A] to-[#101010] p-6 sm:p-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#F87171]">
              Japanese Catalog
            </p>
            <h2 className="mt-3 text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">
              How the JP onboarding is going
            </h2>
            <p className="mt-3 max-w-2xl text-[14px] leading-6 text-[#9CA3AF]">
              Japanese cards came online in May 2026. We're growing the JP catalog one set at a time — measuring price coverage and freshness as we go before scaling up the daily refresh cadence.
            </p>

            {japanese ? (
              <>
                <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-2xl border border-white/[0.05] bg-[#0F0808] p-4">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-[#F87171]">Catalog</p>
                    <p className="mt-2 text-[28px] font-semibold leading-none tracking-[-0.04em] text-white">
                      {formatNumber(japanese.totalCards)}
                    </p>
                    <p className="mt-1 text-[12px] text-[#8B8B8B]">
                      cards across {formatNumber(japanese.totalSets)} {japanese.totalSets === 1 ? "set" : "sets"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/[0.05] bg-[#0F0808] p-4">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-[#F87171]">Pipeline matched</p>
                    <p className="mt-2 text-[28px] font-semibold leading-none tracking-[-0.04em] text-white">
                      {formatPct(japanese.matchedPct)}
                    </p>
                    <p className="mt-1 text-[12px] text-[#8B8B8B]">
                      {formatNumber(japanese.matchedCards)} of {formatNumber(japanese.totalCards)} matched to public market observations
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/[0.05] bg-[#0F0808] p-4">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-[#F87171]">Has RAW price</p>
                    <p className="mt-2 text-[28px] font-semibold leading-none tracking-[-0.04em] text-white">
                      {formatPct(japanese.rawPricePct)}
                    </p>
                    <p className="mt-1 text-[12px] text-[#8B8B8B]">
                      {formatNumber(japanese.rawPriceCards)} have an ungraded headline price
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/[0.05] bg-[#0F0808] p-4">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-[#F87171]">Fresh RAW (7d)</p>
                    <p className="mt-2 text-[28px] font-semibold leading-none tracking-[-0.04em] text-white">
                      {formatPct(japanese.freshPct)}
                    </p>
                    <p className="mt-1 text-[12px] text-[#8B8B8B]">
                      {formatNumber(japanese.freshCards)} RAW prices observed within 7 days
                    </p>
                  </div>
                </div>

                {japanese.latestPriceAsOf ? (
                  <p className="mt-4 text-[12px] text-[#6B7280]">
                    Most recent JP price observed: {formatRelativeTime(japanese.latestPriceAsOf)}
                  </p>
                ) : null}

                {japanese.sets.length > 0 ? (
                  <div className="mt-6 overflow-hidden rounded-2xl border border-white/[0.05] bg-[#0F0808]">
                    <div className="grid grid-cols-12 gap-3 border-b border-white/[0.04] px-4 py-3 text-[11px] uppercase tracking-[0.14em] text-[#6B7280]">
                      <span className="col-span-4 sm:col-span-5">Set</span>
                      <span className="col-span-2 text-right tabular-nums">Cards</span>
                      <span className="col-span-2 text-right tabular-nums">Matched</span>
                      <span className="col-span-2 text-right tabular-nums">RAW</span>
                      <span className="col-span-2 text-right tabular-nums">Fresh</span>
                    </div>
                    {japanese.sets.map((entry) => (
                      <div
                        key={entry.setName}
                        className="grid grid-cols-12 gap-3 border-b border-white/[0.04] px-4 py-3 text-[14px] last:border-b-0"
                      >
                        <div className="col-span-4 sm:col-span-5">
                          <p className="text-[14px] font-medium text-white">{entry.setName}</p>
                          <p className="text-[11px] text-[#6B7280]">
                            {entry.year ?? "—"}
                          </p>
                        </div>
                        <div className="col-span-2 self-center text-right tabular-nums text-[#C9CDD3]">
                          {formatNumber(entry.cardCount)}
                        </div>
                        <div className="col-span-2 self-center text-right tabular-nums">
                          <p className={entry.matchedPct >= 90 ? "text-[#4ADE80]" : entry.matchedPct >= 70 ? "text-[#FBBF24]" : "text-[#F87171]"}>
                            {formatPct(entry.matchedPct)}
                          </p>
                          <p className="text-[11px] text-[#6B7280]">
                            {formatNumber(entry.matchedCount)}/{formatNumber(entry.cardCount)}
                          </p>
                        </div>
                        <div className="col-span-2 self-center text-right tabular-nums text-[#C9CDD3]">
                          <p>{formatPct(entry.rawPricePct)}</p>
                          <p className="text-[11px] text-[#6B7280]">
                            {formatNumber(entry.rawPriceCount)}/{formatNumber(entry.cardCount)}
                          </p>
                        </div>
                        <div className="col-span-2 self-center text-right tabular-nums">
                          <p className={entry.freshPct >= 60 ? "text-[#4ADE80]" : entry.freshPct >= 30 ? "text-[#FBBF24]" : "text-[#F87171]"}>
                            {formatPct(entry.freshPct)}
                          </p>
                          <p className="text-[11px] text-[#6B7280]">
                            {formatRelativeTime(entry.latestPriceAsOf)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="mt-5 space-y-2 text-[13px] leading-6 text-[#8B8B8B]">
                  <p>
                    <span className="font-semibold text-[#C9CDD3]">Reading the metrics.</span> "Pipeline matched" is whether public market observations attached to a canonical card — RAW or graded. "Has RAW price" is whether we can show an ungraded headline price; structurally lower for JP than EN because many JP holos primarily trade as PSA/CGC slabs and have limited RAW NM public data. "Fresh RAW" is how recent that RAW headline is.
                  </p>
                  <p>
                    <span className="font-semibold text-[#C9CDD3]">Onboarding rule.</span> Pipeline matched &gt; 90% on a new set means our matching logic is working. RAW % is informational — it reflects what JP collectors actually trade, not pipeline health. Add the next batch of JP sets when Pipeline matched stays &gt; 90% for a few days.
                  </p>
                </div>
              </>
            ) : (
              <div className="mt-6 rounded-2xl border border-[#78350F] bg-[#1C1917] p-5">
                <p className="text-[12px] uppercase tracking-[0.14em] text-[#FBBF24]">Temporarily Unavailable</p>
                <p className="mt-2 text-[15px] text-[#D1D5DB]">
                  Couldn't load the Japanese catalog snapshot right now. Refresh in a moment.
                </p>
              </div>
            )}
          </section>

          <section id="contribute" className="rounded-[28px] border border-[#1E3A5F] bg-gradient-to-br from-[#0F1B2E] to-[#101010] p-6 sm:p-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#60A5FA]">
              Shape the Market
            </p>
            <h2 className="mt-3 text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">
              Watch your purchase appear on the chart
            </h2>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-[#A8AEB6] sm:text-[16px]">
              Every card you add to your portfolio carries a price you paid. When you opt in, that price becomes an anonymous dot on the public chart for that card — a real transaction, alongside the dealer-listing line. Sparse-market cards are starved for honest signal. Yours fixes that.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/[0.05] bg-[#0A0F18] p-4">
                <p className="text-[11px] uppercase tracking-[0.14em] text-[#60A5FA]">1. Add a card</p>
                <p className="mt-2 text-[14px] leading-6 text-[#C9CDD3]">
                  Open your portfolio. Add the card with the price you paid and the date you got it.
                </p>
              </div>
              <div className="rounded-2xl border border-white/[0.05] bg-[#0A0F18] p-4">
                <p className="text-[11px] uppercase tracking-[0.14em] text-[#60A5FA]">2. Tick the box</p>
                <p className="mt-2 text-[14px] leading-6 text-[#C9CDD3]">
                  Check &ldquo;Anonymously share this price with the community.&rdquo; Off by default. Only price + date are shared. Never your identity.
                </p>
              </div>
              <div className="rounded-2xl border border-white/[0.05] bg-[#0A0F18] p-4">
                <p className="text-[11px] uppercase tracking-[0.14em] text-[#60A5FA]">3. Watch it appear</p>
                <p className="mt-2 text-[14px] leading-6 text-[#C9CDD3]">
                  Visit the card&rsquo;s detail page. Your purchase is a blue dot on the chart, sitting next to the dealer line.
                </p>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/portfolio"
                className="inline-flex items-center gap-2 rounded-xl bg-[#3B82F6] px-5 py-2.5 text-[14px] font-semibold text-white transition hover:bg-[#2563EB]"
              >
                Open my portfolio
                <ArrowRight size={14} />
              </Link>
              <p className="text-[12px] text-[#6B7280]">
                The toggle is on the &ldquo;Add lot&rdquo; form.
              </p>
            </div>
          </section>

          <section id="methodology" className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
              How We Compute This
            </p>
            <h2 className="mt-3 text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">
              Methodology
            </h2>
            <ul className="mt-4 space-y-3 text-[14px] leading-6 text-[#C9CDD3]">
              <li>
                <span className="font-semibold text-white">Tier classification.</span> A card is <span className="text-[#F87171]">hot</span> if it trades on 4+ days in the past week or has 8+ price changes in the last month;
                <span className="text-[#FBBF24]"> warm</span> if it trades on 6+ days in the last month;
                <span className="text-[#60A5FA]"> sparse</span> if there's at least one matched observation in the past 180 days;
                <span className="text-[#9CA3AF]"> dormant</span> otherwise.
              </li>
              <li>
                <span className="font-semibold text-white">Refresh cadence.</span> Hot cards refresh every six hours. Warm refreshes daily. Sparse refreshes a few times a week. Dormant gets a weekly sweep so a sale brings it back to life.
              </li>
              <li>
                <span className="font-semibold text-white">Source.</span> Market Price is PopAlpha&apos;s conservative public market anchor. Recent market signals appear separately when they meaningfully diverge. No invented data, no synthetic fills.
              </li>
              <li>
                <span className="font-semibold text-white">Last classified.</span>{" "}
                {tierSummary?.computedAt ? formatRelativeTime(tierSummary.computedAt) : "—"} — tiers re-evaluate weekly so a card moves from sparse to hot when the market wakes it up.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </CanonicalCardShell>
  );
}
