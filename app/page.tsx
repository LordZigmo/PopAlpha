import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";
import {
  Camera,
  LineChart,
  Search,
  Sparkles,
} from "lucide-react";
import CardTileMini from "@/components/card-tile-mini";
import HomepageFollowSurface from "@/components/homepage-follow-surface";
import HomepageSearch from "@/components/homepage-search";
import { buildPopAlphaScoutSummary } from "@/lib/ai/scout-summary";
import { getHomepageData, type HomepageCard } from "@/lib/data/homepage";
import { POKETRACE_CAMERA_HREF } from "@/lib/poketrace/ui-paths";

export const dynamic = "force-dynamic";

const EMPTY_DATA = {
  movers: [],
  high_confidence_movers: [],
  emerging_movers: [],
  losers: [],
  trending: [],
  as_of: null,
} as const;

const DATA_TIMEOUT_MS = 8_000;

function timeAgo(iso: string | null): string {
  if (!iso) return "Live now";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  return `Updated ${Math.floor(hrs / 24)}d ago`;
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
    timeZoneName: "short",
  }).format(parsed);
}

function formatPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatSignedPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
}

function getFeaturedCard(...groups: HomepageCard[][]): HomepageCard | null {
  for (const group of groups) {
    if (group[0]) return group[0];
  }
  return null;
}

function getUniqueSetNames(cards: HomepageCard[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const card of cards) {
    const setName = card.set_name?.trim();
    if (!setName || seen.has(setName)) continue;
    seen.add(setName);
    out.push(setName);
    if (out.length >= limit) break;
  }

  return out;
}

function getLeadSet(cards: HomepageCard[]): string | null {
  const counts = new Map<string, number>();

  for (const card of cards) {
    const setName = card.set_name?.trim();
    if (!setName) continue;
    counts.set(setName, (counts.get(setName) ?? 0) + 1);
  }

  const leader = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return leader?.[0] ?? null;
}

function buildMoverSectionSummary(cards: HomepageCard[]): string {
  const leader = cards[0];
  if (!leader) {
    return "Fresh pricing is still filling in. Search a card to open live pricing, Scout context, and recent market history.";
  }

  const change = formatSignedPct(leader.change_pct);
  const leadershipPocket = leader.set_name ?? "The leadership pocket";
  return `${leader.name} is leading the tape, and the strongest names behind it still clear our freshness, liquidity, and confidence checks.${change ? ` ${leadershipPocket} is also carrying a ${change} move at the front of the board.` : ""}`;
}

function buildFeaturedBrief(card: HomepageCard | null): string {
  if (!card) {
    return "Search a card to open live pricing, read the AI market brief, and see whether the signal is strengthening or fading.";
  }

  return buildPopAlphaScoutSummary({
    cardName: card.name,
    marketPrice: card.market_price,
    fairValue: null,
    changePct: card.change_pct,
    changeLabel: card.change_window === "7D" ? "7d" : "24h",
    activeListings7d: null,
  }).summaryLong;
}

function getConfidenceLabel(card: HomepageCard): string {
  if (card.low_confidence) return "Low confidence";
  if ((card.confidence_score ?? 0) >= 85) return "High confidence";
  if ((card.confidence_score ?? 0) >= 70) return "Solid confidence";
  return "Watch signal";
}

function NavButton({
  href,
  label,
  emphasis = "muted",
}: {
  href: string;
  label: string;
  emphasis?: "muted" | "strong";
}) {
  return (
    <Link
      href={href}
      className={[
        "inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold transition",
        emphasis === "strong"
          ? "border border-white bg-white text-[#06080C] hover:bg-[#DDE4EF]"
          : "border border-white/[0.08] bg-white/[0.03] text-[#D4DBE6] hover:border-white/[0.14] hover:text-white",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}

function HeroSignal({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F7A8E]">{label}</p>
      <p className="mt-2 text-sm font-semibold text-[#EEF2F8]">{value}</p>
    </div>
  );
}

function LoopStep({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Search;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[1.4rem] border border-white/[0.06] bg-[#0B1017]/75 px-4 py-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04] text-[#DCE6F5]">
        <Icon size={18} strokeWidth={2.2} />
      </div>
      <p className="mt-4 text-sm font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm leading-6 text-[#8E98AA]">{body}</p>
    </div>
  );
}

function EmptyPanel({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[1.7rem] border border-dashed border-white/[0.08] bg-white/[0.02] px-5 py-6 text-left">
      <p className="text-base font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm leading-6 text-[#7E8798]">{body}</p>
    </div>
  );
}

function FeaturedBriefPanel({
  card,
  summary,
  updatedLabel,
  updatedIso,
  updatedTitle,
}: {
  card: HomepageCard | null;
  summary: string;
  updatedLabel: string;
  updatedIso: string | null;
  updatedTitle: string | null;
}) {
  const change = formatSignedPct(card?.change_pct ?? null);

  return (
    <section className="relative overflow-hidden rounded-[2rem] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(11,16,24,0.98),rgba(7,10,15,0.98))] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.42)] sm:p-7">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(37,99,235,0.22),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(16,185,129,0.14),transparent_28%)]" />
      <div className="relative z-10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-[#63D471]/18 bg-[#63D471]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#A7F3BF]">
              <Sparkles size={12} strokeWidth={2.3} />
              AI market brief
            </div>
            <h2 className="mt-4 text-[28px] font-semibold tracking-[-0.04em] text-white sm:text-[32px]">
              {card ? `PopAlpha Scout on ${card.name}` : "PopAlpha Scout is watching the tape"}
            </h2>
            <p className="mt-3 max-w-xl text-[15px] leading-7 text-[#A7B0C0]">{summary}</p>
          </div>
          <time
            title={updatedTitle ?? undefined}
            dateTime={updatedIso ?? undefined}
            className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#B8C2D1]"
          >
            {updatedLabel}
          </time>
        </div>

        {card ? (
          <div className="mt-6 rounded-[1.6rem] border border-white/[0.08] bg-black/[0.22] p-4">
            <div className="flex gap-4">
              <Link
                href={`/c/${encodeURIComponent(card.slug)}`}
                className="block aspect-[63/88] w-[92px] shrink-0 overflow-hidden rounded-[1.1rem] border border-white/[0.08] bg-[#0B0F15]"
              >
                {card.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.image_url} alt={card.name} className="h-full w-full object-cover" />
                ) : null}
              </Link>
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold text-white">{card.name}</p>
                <p className="mt-1 text-sm text-[#8390A3]">{card.set_name ?? "Unknown set"}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-sm font-semibold text-white">
                    {formatPrice(card.market_price)}
                  </span>
                  {change ? (
                    <span
                      className={[
                        "rounded-full border px-3 py-1.5 text-sm font-semibold",
                        (card.change_pct ?? 0) >= 0
                          ? "border-emerald-400/20 bg-emerald-500/10 text-[#9BE7B2]"
                          : "border-rose-400/20 bg-rose-500/10 text-[#F7B0BA]",
                      ].join(" ")}
                    >
                      {change} {card.change_window ?? ""}
                    </span>
                  ) : null}
                  <span className="rounded-full border border-sky-400/18 bg-sky-500/10 px-3 py-1.5 text-sm font-semibold text-[#B5DCFF]">
                    {getConfidenceLabel(card)}
                  </span>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <NavButton href={`/c/${encodeURIComponent(card.slug)}`} label="Open signal" emphasis="strong" />
                  <NavButton href={POKETRACE_CAMERA_HREF} label="Scan a card" />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-6">
            <EmptyPanel
              title="No featured signal yet"
              body="Pricing is still filling in. Search a card to open the market brief as soon as the board has enough data to support it."
            />
          </div>
        )}
      </div>
    </section>
  );
}

function LeadMoverPanel({ card }: { card: HomepageCard | null }) {
  const change = formatSignedPct(card?.change_pct ?? null);

  if (!card) {
    return (
      <EmptyPanel
        title="No high-confidence movers yet"
        body="We only surface this rail when a card has enough fresh pricing and enough market coverage to trust the move."
      />
    );
  }

  return (
    <article className="relative overflow-hidden rounded-[1.9rem] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(12,16,24,0.96),rgba(8,10,14,0.98))] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(37,99,235,0.18),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(99,212,113,0.12),transparent_26%)]" />
      <div className="relative z-10">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#80A1D6]">Featured mover</p>
        <div className="mt-4 flex gap-4">
          <Link
            href={`/c/${encodeURIComponent(card.slug)}`}
            className="block aspect-[63/88] w-[128px] shrink-0 overflow-hidden rounded-[1.2rem] border border-white/[0.08] bg-[#0B0F15]"
          >
            {card.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.image_url} alt={card.name} className="h-full w-full object-cover" />
            ) : null}
          </Link>
          <div className="min-w-0">
            <Link href={`/c/${encodeURIComponent(card.slug)}`} className="text-[24px] font-semibold tracking-[-0.03em] text-white hover:text-[#E3ECFA]">
              {card.name}
            </Link>
            <p className="mt-2 text-sm text-[#8390A3]">{card.set_name ?? "Unknown set"}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-sm font-semibold text-white">
                {formatPrice(card.market_price)}
              </span>
              {change ? (
                <span
                  className={[
                    "rounded-full border px-3 py-1.5 text-sm font-semibold",
                    (card.change_pct ?? 0) >= 0
                      ? "border-emerald-400/20 bg-emerald-500/10 text-[#9BE7B2]"
                      : "border-rose-400/20 bg-rose-500/10 text-[#F7B0BA]",
                  ].join(" ")}
                >
                  {change} {card.change_window ?? ""}
                </span>
              ) : null}
            </div>
            <p className="mt-5 text-sm leading-7 text-[#A1ABBC]">
              {buildFeaturedBrief(card)}
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

function CompactSignalList({
  title,
  subtitle,
  cards,
}: {
  title: string;
  subtitle: string;
  cards: HomepageCard[];
}) {
  if (cards.length === 0) {
    return <EmptyPanel title={title} body="Fresh cards will appear here as soon as the next pocket of momentum starts to build." />;
  }

  return (
    <section className="rounded-[1.7rem] border border-white/[0.08] bg-[#0A0F15]/88 p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#71819B]">{title}</p>
      <p className="mt-3 text-sm leading-6 text-[#93A0B4]">{subtitle}</p>
      <div className="mt-5 space-y-3">
        {cards.slice(0, 3).map((card) => (
          <Link
            key={card.slug}
            href={`/c/${encodeURIComponent(card.slug)}`}
            className="flex items-center justify-between gap-3 rounded-[1.2rem] border border-white/[0.06] bg-white/[0.03] px-4 py-3 transition hover:border-white/[0.12]"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{card.name}</p>
              <p className="mt-1 truncate text-[13px] text-[#7F8A9B]">{card.set_name ?? "Unknown set"}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-semibold text-white">{formatPrice(card.market_price)}</p>
              <p className="mt-1 text-[13px] font-semibold text-[#9BE7B2]">{formatSignedPct(card.change_pct) ?? "Signal forming"}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function HomePage() {
  const user = await currentUser();
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

  const movers = Array.isArray(data?.movers) ? data.movers : [];
  const highConfidenceMovers = Array.isArray(data?.high_confidence_movers) ? data.high_confidence_movers : [];
  const emergingMovers = Array.isArray(data?.emerging_movers) ? data.emerging_movers : [];
  const trending = Array.isArray(data?.trending) ? data.trending : [];
  const featuredCard = getFeaturedCard(highConfidenceMovers, movers, trending);
  const leadMover = highConfidenceMovers[0] ?? movers[0] ?? null;
  const moverRailCards = highConfidenceMovers.length > 1 ? highConfidenceMovers.slice(1, 5) : movers.slice(1, 5);
  const heroSetPills = getUniqueSetNames(
    [...highConfidenceMovers, ...movers, ...trending],
    4,
  );
  const updatedLabel = timeAgo(data?.as_of ?? null);
  const updatedTitle = formatExactTimestamp(data?.as_of ?? null);
  const leadSet = getLeadSet(highConfidenceMovers.length > 0 ? highConfidenceMovers : movers);

  return (
    <main className="relative min-h-screen overflow-x-clip bg-[#050608] pb-24 text-[#F5F7FA]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(29,78,216,0.16),transparent_32%),radial-gradient(circle_at_top_right,rgba(16,185,129,0.11),transparent_28%),linear-gradient(180deg,#050608_0%,#070A0F_42%,#050608_100%)]" />
      <div className="pointer-events-none absolute left-[-10rem] top-24 h-72 w-72 rounded-full bg-[#0F3A83]/18 blur-[110px]" />
      <div className="pointer-events-none absolute right-[-6rem] top-72 h-72 w-72 rounded-full bg-[#0E7A57]/16 blur-[120px]" />

      <div className="relative mx-auto max-w-7xl px-4 pb-14 pt-6 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-4 rounded-full border border-white/[0.08] bg-[#070B11]/78 px-4 py-3 shadow-[0_14px_50px_rgba(0,0,0,0.22)] backdrop-blur-xl">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <Image
              src="/brand/popalpha-icon.svg"
              alt="PopAlpha"
              width={56}
              height={56}
              className="h-11 w-11 shrink-0"
              priority
            />
            <div className="min-w-0">
              <p className="text-base font-semibold tracking-[-0.02em] text-white">PopAlpha</p>
              <p className="truncate text-[12px] text-[#7F8A9B]">Live market intelligence for Pokémon collectors</p>
            </div>
          </Link>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 sm:flex">
              <NavButton href="/about" label="About" />
              <NavButton href="/search" label="Search" />
            </div>
            <NavButton href={user ? "/portfolio" : "/sign-in"} label={user ? "Open app" : "Sign in"} emphasis="strong" />
          </div>
        </header>

        <section className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(360px,0.92fr)] lg:items-stretch">
          <div className="relative overflow-hidden rounded-[2rem] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(11,16,24,0.96),rgba(7,10,15,0.98))] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.42)] sm:p-8">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(96,165,250,0.18),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(99,212,113,0.12),transparent_28%)]" />
            <div className="relative z-10">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#D7DEE8]">
                <span className="h-2 w-2 rounded-full bg-[#63D471] shadow-[0_0_14px_rgba(99,212,113,0.9)]" />
                Live market intelligence
              </div>

              <h1 className="mt-5 max-w-4xl text-[42px] font-semibold leading-[1.02] tracking-[-0.05em] text-white sm:text-[58px]">
                Track prices, spot movers, and act on real Pokémon market signals.
              </h1>
              <p className="mt-4 max-w-2xl text-[17px] leading-7 text-[#A9B3C4]">
                Search is the fastest way into PopAlpha. Open a card, read the AI market brief, and decide whether the move is worth following.
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <HeroSignal label="Board status" value={updatedLabel} />
                <HeroSignal
                  label="Qualified movers"
                  value={highConfidenceMovers.length > 0 ? `${highConfidenceMovers.length} cards on signal` : "Watching for fresh leadership"}
                />
                <HeroSignal
                  label="Leadership pocket"
                  value={leadSet ?? "Signal still broadening"}
                />
              </div>

              <div className="mt-8 rounded-[1.7rem] border border-white/[0.08] bg-[#090D14]/88 p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold text-white">Search a card</p>
                    <p className="mt-1 text-sm text-[#8F98A8]">
                      Search any card, set, or cert to open pricing, the Scout brief, and recent market context.
                    </p>
                  </div>
                  <Link
                    href={POKETRACE_CAMERA_HREF}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-4 text-sm font-semibold text-[#D7DEE8] transition hover:border-white/[0.14] hover:text-white"
                  >
                    <Camera size={16} strokeWidth={2.1} />
                    Scan instead
                  </Link>
                </div>

                <div className="mt-4">
                  <Suspense
                    fallback={
                      <div className="h-[60px] rounded-full border border-white/[0.06] bg-[#11151D] opacity-40" />
                    }
                  >
                    <HomepageSearch />
                  </Suspense>
                </div>

                {heroSetPills.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {heroSetPills.map((setName) => (
                      <Link
                        key={setName}
                        href={`/search?q=${encodeURIComponent(setName)}`}
                        className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[12px] font-semibold text-[#B8C2D1] transition hover:border-white/[0.14] hover:text-white"
                      >
                        {setName}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <LoopStep
                  icon={Search}
                  title="Search or scan"
                  body="Start with the card you already care about instead of browsing a crowded dashboard."
                />
                <LoopStep
                  icon={Sparkles}
                  title="Read the brief"
                  body="Get the clearest pricing context and a fast Scout read on whether the move still looks real."
                />
                <LoopStep
                  icon={LineChart}
                  title="Follow the signal"
                  body="Save the names worth revisiting so you can come back when leadership shifts."
                />
              </div>
            </div>
          </div>

          <FeaturedBriefPanel
            card={featuredCard}
            summary={buildFeaturedBrief(featuredCard)}
            updatedLabel={updatedLabel}
            updatedIso={data?.as_of ?? null}
            updatedTitle={updatedTitle}
          />
        </section>

        <section className="mt-14">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F7A8E]">Signal board</p>
              <h2 className="mt-3 text-[34px] font-semibold tracking-[-0.04em] text-white">
                High-Confidence Movers
              </h2>
              <p className="mt-3 max-w-2xl text-[16px] leading-7 text-[#A4AEBD]">
                The board is tighter here by design. These are the moves with enough freshness, enough coverage, and enough liquidity to feel actionable instead of noisy.
              </p>
            </div>

            <div className="rounded-[1.4rem] border border-white/[0.08] bg-white/[0.03] px-4 py-3 lg:max-w-md">
              <p className="text-sm font-semibold text-white">{buildMoverSectionSummary(highConfidenceMovers.length > 0 ? highConfidenceMovers : movers)}</p>
              {updatedTitle ? (
                <p className="mt-2 text-[13px] text-[#7F8A9B]">{updatedTitle}</p>
              ) : null}
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.65fr)] lg:items-start">
            <LeadMoverPanel card={leadMover} />

            <div
              className="flex gap-4 overflow-x-auto pb-2 sm:pr-1 lg:grid lg:auto-rows-fr lg:grid-cols-2 lg:overflow-visible lg:pb-0"
              style={{
                scrollSnapType: "x mandatory",
                WebkitOverflowScrolling: "touch",
                scrollbarWidth: "none",
              }}
            >
              {moverRailCards.map((card) => (
                <CardTileMini
                  key={card.slug}
                  card={card}
                  className="w-[min(16rem,72vw)] sm:w-[12.25rem] lg:w-auto"
                />
              ))}
              {moverRailCards.length === 0 ? (
                <div className="w-full lg:col-span-2">
                  <EmptyPanel
                    title="No supporting movers yet"
                    body="The lead signal is still alone. As more qualified cards appear, they will populate here automatically."
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <CompactSignalList
              title="Watch next"
              subtitle="Fresh names gaining traction behind the top mover. Use this rail to catch the next rotation before it becomes crowded."
              cards={emergingMovers.length > 0 ? emergingMovers : trending}
            />
            <HomepageFollowSurface signedIn={!!user} />
          </div>
        </section>
      </div>
    </main>
  );
}
