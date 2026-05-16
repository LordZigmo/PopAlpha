"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  HomepageCard,
  HomepageSignalWindow,
  HomepageWindowedCards,
} from "@/lib/data/homepage";
import {
  PRICING_DISPLAY_V2_ENABLED,
  formatPriceDisplay,
  resolveDisplayedMarketPrice,
} from "@/lib/pricing/displayed-market-price";
import { formatJpSourcePriceLabel, selectJpPriceSource } from "@/lib/pricing/jp-price-source";
import { useMarket } from "@/lib/market-context";

type SignalWindow = HomepageSignalWindow;
type HomepageSignalBoardProps = {
  topMoversByWindow: HomepageWindowedCards;
  biggestDropsByWindow: HomepageWindowedCards;
  momentumByWindow: HomepageWindowedCards;
  midMovers: HomepageCard[];
  budgetMovers: HomepageCard[];
  japaneseTopMoversByWindow: HomepageWindowedCards;
  japaneseBiggestDropsByWindow: HomepageWindowedCards;
  japaneseMomentumByWindow: HomepageWindowedCards;
  japaneseMidMovers: HomepageCard[];
  japaneseBudgetMovers: HomepageCard[];
  japanese: HomepageCard[];
};

const SIGNAL_WINDOWS: SignalWindow[] = ["24H", "7D"];

function formatPrice(n: number | null): string {
  if (n == null || n <= 0) return "--";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(n: number | null): string {
  if (n == null) return "--";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function pillClasses(n: number | null): string {
  const v = n ?? 0;
  if (v > 0) return "bg-[#00DC5A]/10 text-[#00DC5A]";
  if (v < 0) return "bg-[#FF3B30]/10 text-[#FF3B30]";
  return "bg-white/[0.06] text-[#9CA3AF]";
}

export default function HomepageSignalBoard({
  topMoversByWindow,
  biggestDropsByWindow,
  momentumByWindow,
  midMovers,
  budgetMovers,
  japaneseTopMoversByWindow,
  japaneseBiggestDropsByWindow,
  japaneseMomentumByWindow,
  japaneseMidMovers,
  japaneseBudgetMovers,
  japanese,
}: HomepageSignalBoardProps) {
  const { market } = useMarket();

  if (market === "JP") {
    return (
      <JapaneseSignalBoard
        topMoversByWindow={japaneseTopMoversByWindow}
        biggestDropsByWindow={japaneseBiggestDropsByWindow}
        momentumByWindow={japaneseMomentumByWindow}
        midMovers={japaneseMidMovers}
        budgetMovers={japaneseBudgetMovers}
        discovery={japanese}
      />
    );
  }

  return (
    <EnglishSignalBoard
      topMoversByWindow={topMoversByWindow}
      biggestDropsByWindow={biggestDropsByWindow}
      momentumByWindow={momentumByWindow}
      midMovers={midMovers}
      budgetMovers={budgetMovers}
    />
  );
}

function EnglishSignalBoard({
  topMoversByWindow,
  biggestDropsByWindow,
  momentumByWindow,
  midMovers,
  budgetMovers,
}: {
  topMoversByWindow: HomepageWindowedCards;
  biggestDropsByWindow: HomepageWindowedCards;
  momentumByWindow: HomepageWindowedCards;
  midMovers: HomepageCard[];
  budgetMovers: HomepageCard[];
}) {
  const [selectedWindow, setSelectedWindow] = useState<SignalWindow>("24H");
  const momentumTitle = selectedWindow === "24H" ? "Recent momentum" : "Sustained momentum";
  const momentumEmptyMessage = selectedWindow === "24H"
    ? "No 24H momentum cards yet"
    : "No 7D momentum cards yet";

  return (
    <>
      <SignalRailSection
        id="top-movers"
        eyebrow="Recent Market"
        eyebrowClassName="text-[#00B4D8]"
        title="Top movers"
        cards={topMoversByWindow[selectedWindow]}
        emptyMessage={`No ${selectedWindow} movers yet`}
        headerSlot={(
          <div className="flex items-center gap-2.5">
            <WindowTabs selectedWindow={selectedWindow} onChange={setSelectedWindow} />
            <Link href="/search" className="text-[13px] font-medium text-[#00B4D8] transition-colors hover:text-white">
              View all →
            </Link>
          </div>
        )}
      />

      <SignalRailSection
        id="biggest-drops"
        eyebrow="Pullbacks"
        eyebrowClassName="text-[#FF6B6B]"
        title="Biggest drops"
        cards={biggestDropsByWindow[selectedWindow]}
        emptyMessage={`No ${selectedWindow} pullbacks yet`}
      />

      <SignalRailSection
        id="momentum-rail"
        eyebrow="Momentum"
        eyebrowClassName="text-[#7C3AED]"
        title={momentumTitle}
        cards={momentumByWindow[selectedWindow]}
        emptyMessage={momentumEmptyMessage}
      />

      <SignalRailSection
        id="mid-movers"
        eyebrow="$8 – $50"
        eyebrowClassName="text-[#10B981]"
        title="Mid-tier movers"
        cards={midMovers}
        emptyMessage="No mid-tier movers yet"
      />

      <SignalRailSection
        id="budget-movers"
        eyebrow="Under $8"
        eyebrowClassName="text-[#F59E0B]"
        title="Budget movers"
        cards={budgetMovers}
        emptyMessage="No budget movers yet"
      />
    </>
  );
}

function JapaneseSignalBoard({
  topMoversByWindow,
  biggestDropsByWindow,
  momentumByWindow,
  midMovers,
  budgetMovers,
  discovery,
}: {
  topMoversByWindow: HomepageWindowedCards;
  biggestDropsByWindow: HomepageWindowedCards;
  momentumByWindow: HomepageWindowedCards;
  midMovers: HomepageCard[];
  budgetMovers: HomepageCard[];
  discovery: HomepageCard[];
}) {
  const [selectedWindow, setSelectedWindow] = useState<SignalWindow>("24H");
  const momentumTitle = selectedWindow === "24H" ? "Recent JP momentum" : "Sustained JP momentum";
  const momentumEmptyMessage = selectedWindow === "24H"
    ? "No 24H JP momentum yet"
    : "No 7D JP momentum yet";

  // Every JP rail links its "View all" to the JP-scoped search and uses
  // the rail's red accent, so clicking through never drops the user
  // into the unfiltered EN search board.
  const jpViewAllHref = "/search?language=JP";
  const jpViewAllClass = "text-[#F87171]";

  return (
    <>
      <SignalRailSection
        id="jp-top-movers"
        eyebrow="JP · Recent Market"
        eyebrowClassName="text-[#F87171]"
        title="Top movers"
        cards={topMoversByWindow[selectedWindow]}
        emptyMessage={`No ${selectedWindow} JP movers yet`}
        useJpSource
        viewAllHref={jpViewAllHref}
        viewAllClassName={jpViewAllClass}
        headerSlot={(
          <div className="flex items-center gap-2.5">
            <WindowTabs selectedWindow={selectedWindow} onChange={setSelectedWindow} />
            <Link href={jpViewAllHref} className={`text-[13px] font-medium transition-colors hover:text-white ${jpViewAllClass}`}>
              View all →
            </Link>
          </div>
        )}
      />

      <SignalRailSection
        id="jp-biggest-drops"
        eyebrow="JP · Pullbacks"
        eyebrowClassName="text-[#FCA5A5]"
        title="Biggest drops"
        cards={biggestDropsByWindow[selectedWindow]}
        emptyMessage={`No ${selectedWindow} JP pullbacks yet`}
        useJpSource
        viewAllHref={jpViewAllHref}
        viewAllClassName={jpViewAllClass}
      />

      <SignalRailSection
        id="jp-momentum"
        eyebrow="JP · Momentum"
        eyebrowClassName="text-[#F472B6]"
        title={momentumTitle}
        cards={momentumByWindow[selectedWindow]}
        emptyMessage={momentumEmptyMessage}
        useJpSource
        viewAllHref={jpViewAllHref}
        viewAllClassName={jpViewAllClass}
      />

      <SignalRailSection
        id="jp-mid-movers"
        eyebrow="JP · $8 – $50"
        eyebrowClassName="text-[#FB923C]"
        title="Mid-tier movers"
        cards={midMovers}
        emptyMessage="No mid-tier JP movers yet"
        useJpSource
        viewAllHref={jpViewAllHref}
        viewAllClassName={jpViewAllClass}
      />

      <SignalRailSection
        id="jp-budget-movers"
        eyebrow="JP · Under $8"
        eyebrowClassName="text-[#FBBF24]"
        title="Budget movers"
        cards={budgetMovers}
        emptyMessage="No budget JP movers yet"
        useJpSource
        viewAllHref={jpViewAllHref}
        viewAllClassName={jpViewAllClass}
      />

      <SignalRailSection
        id="jp-discovery"
        eyebrow="JP · Fresh in the catalog"
        eyebrowClassName="text-[#F87171]"
        title="Japanese cards"
        cards={discovery}
        emptyMessage="No Japanese cards yet"
        useJpSource
        viewAllHref={jpViewAllHref}
        viewAllClassName={jpViewAllClass}
      />
    </>
  );
}

function WindowTabs({
  selectedWindow,
  onChange,
}: {
  selectedWindow: SignalWindow;
  onChange: (window: SignalWindow) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5">
      {SIGNAL_WINDOWS.map((window) => (
        <button
          key={window}
          type="button"
          onClick={() => onChange(window)}
          aria-pressed={selectedWindow === window}
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-[0.16em] transition-all ${
            selectedWindow === window
              ? "bg-white text-[#05070A] shadow-[0_10px_30px_rgba(255,255,255,0.16)]"
              : "text-[#87929D] hover:text-white"
          }`}
        >
          {window}
        </button>
      ))}
    </div>
  );
}

function SignalRailSection({
  id,
  eyebrow,
  eyebrowClassName,
  title,
  cards,
  emptyMessage,
  headerSlot,
  spacingClassName,
  useJpSource = false,
  viewAllHref = "/search",
  viewAllClassName = "text-[#00B4D8]",
}: {
  id: string;
  eyebrow: string;
  eyebrowClassName: string;
  title: string;
  cards: HomepageCard[];
  emptyMessage: string;
  headerSlot?: ReactNode;
  spacingClassName?: string;
  useJpSource?: boolean;
  viewAllHref?: string;
  viewAllClassName?: string;
}) {
  return (
    <section id={id} className={`border-t border-white/[0.04] ${spacingClassName ?? "py-5 sm:py-6"}`}>
      <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
        <div className="flex items-end justify-between gap-3">
          <div>
            <span className={`text-[11px] font-semibold uppercase tracking-[0.2em] ${eyebrowClassName}`}>{eyebrow}</span>
            <div className="mt-1 flex flex-wrap items-center gap-2.5">
              <h2 className="text-[clamp(1.5rem,3vw,2rem)] font-bold tracking-tight text-white">{title}</h2>
            </div>
          </div>
          {headerSlot ?? (
            <Link href={viewAllHref} className={`text-[13px] font-medium transition-colors hover:text-white ${viewAllClassName}`}>
              View all →
            </Link>
          )}
        </div>

        <div
          className="landing-scroll-rail mt-3 flex gap-3 overflow-x-auto pb-2"
          style={{ scrollSnapType: "x mandatory" }}
        >
          {cards.map((card) => (
            <SignalCard
              key={`${id}-${card.slug}`}
              card={card}
              useJpSource={useJpSource}
            />
          ))}
          {cards.length === 0 && (
            <div className="flex h-40 w-full items-center justify-center text-[13px] text-[#444]">
              {emptyMessage}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SignalCard({ card, useJpSource = false }: { card: HomepageCard; useJpSource?: boolean }) {
  // JP rails: pick Yahoo!JP / Snkrdunk when a source qualifies on sample
  // count (see lib/pricing/jp-price-source.ts). When a JP source is
  // picked we render its ¥-native label ("¥3,200 ($21.00)") and tag the
  // tile with the source name. The change-pct badge is hidden in that
  // case because today's change_pct comes from Scrydex's USD reflection
  // and doesn't describe a JP-source price baseline — mirrors the iOS
  // `preferringJpSource()` transform.
  const jpPick = useJpSource
    ? selectJpPriceSource({
        yahooJpPrice: card.yahoo_jp_price,
        yahooJpPriceJpy: card.yahoo_jp_price_jpy,
        yahooJpSampleCount: card.yahoo_jp_sample_count,
        snkrdunkPrice: card.snkrdunk_price,
        snkrdunkPriceJpy: card.snkrdunk_price_jpy,
        snkrdunkSampleCount: card.snkrdunk_sample_count,
      })
    : null;
  const jpLabel = jpPick && jpPick.source ? formatJpSourcePriceLabel(jpPick) : null;
  const showJp = jpLabel != null;

  const priceDisplay = !showJp && PRICING_DISPLAY_V2_ENABLED
    ? resolveDisplayedMarketPrice({
        marketPrice: card.market_price,
        marketPriceAsOf: card.updated_at,
      })
    : null;
  const priceMeta = priceDisplay ? formatPriceDisplay(priceDisplay) : null;

  return (
    <Link
      href={`/c/${encodeURIComponent(card.slug)}`}
      className="group w-[208px] shrink-0 overflow-hidden rounded-[18px] border border-white/[0.06] bg-[#0C0C10] transition-all hover:border-[#00B4D8]/20 hover:shadow-[0_12px_40px_rgba(0,180,216,0.08)] sm:w-[224px]"
      style={{ scrollSnapAlign: "start" }}
    >
      <div className="relative overflow-hidden bg-gradient-to-b from-[#12121a] to-[#0C0C10] p-3 pb-2.5">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent" />
        {card.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.image_url}
            alt={card.name}
            className="relative mx-auto aspect-[63/88] w-full rounded-lg object-cover shadow-[0_12px_35px_rgba(0,0,0,0.5)] transition-transform duration-300 group-hover:scale-[1.04] group-hover:shadow-[0_16px_45px_rgba(0,0,0,0.6)]"
          />
        ) : (
          <div className="mx-auto aspect-[63/88] w-full rounded-lg bg-gradient-to-br from-[#1a1a2e] to-[#0a0a12] shadow-[0_12px_35px_rgba(0,0,0,0.5)]" />
        )}
      </div>
      <div className="px-3 pb-3">
        <p className="truncate text-[14px] font-semibold text-[#E4E4E7] group-hover:text-white">{card.name}</p>
        <p className="mt-0.5 truncate text-[11px] text-[#555]">{card.set_name}</p>
        {showJp && jpPick?.label ? (
          <p className="mt-0.5 truncate text-[10px] font-medium uppercase tracking-[0.12em] text-[#F87171]">
            {jpPick.label}
          </p>
        ) : null}
        <div className="mt-2 flex items-center justify-between border-t border-white/[0.04] pt-2">
          <span
            className={`min-w-0 truncate font-bold tabular-nums ${
              !showJp && priceMeta?.subdued ? "text-[12px] text-[#9CA3AF]" : "text-[15px] text-white"
            }`}
            title={!showJp && priceDisplay?.kind === "stale_old" ? "Sparse market — last sold price shown" : undefined}
          >
            {showJp ? jpLabel : (priceMeta ? priceMeta.label : formatPrice(card.market_price))}
          </span>
          {showJp ? null : (priceMeta?.showChangeBadge ?? true) ? (
            <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-bold tabular-nums ${pillClasses(card.change_pct)}`}>
              {formatPct(card.change_pct)}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
