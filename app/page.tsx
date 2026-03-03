import { Suspense } from "react";
import { getHomepageData } from "@/lib/data/homepage";
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

export default async function HomePage() {
  console.log("[homepage] rendering started", new Date().toISOString());
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

        <div className="mt-5">
          <Suspense
            fallback={
              <div className="h-[60px] rounded-full border border-white/[0.06] bg-[#111] opacity-40" />
            }
          >
            <HomepageSearch />
          </Suspense>
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
          <div className="flex min-h-[100px] items-center justify-center rounded-2xl border border-dashed border-white/[0.08] bg-[#111]/50">
            <p className="text-[13px] text-[#444]">
              Sentiment voting coming soon
            </p>
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
