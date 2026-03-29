"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  HomepageCard,
  HomepageSignalWindow,
  HomepageWindowedCards,
} from "@/lib/data/homepage";

type SignalWindow = HomepageSignalWindow;
type HomepageSignalBoardProps = {
  topMoversByWindow: HomepageWindowedCards;
  biggestDropsByWindow: HomepageWindowedCards;
  momentumByWindow: HomepageWindowedCards;
};

const SIGNAL_WINDOWS: SignalWindow[] = ["24H", "7D"];

function formatPrice(n: number | null): string {
  if (n == null || n <= 0) return "--";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(n: number | null): string {
  if (n == null) return "--";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export default function HomepageSignalBoard({
  topMoversByWindow,
  biggestDropsByWindow,
  momentumByWindow,
}: HomepageSignalBoardProps) {
  const [selectedWindow, setSelectedWindow] = useState<SignalWindow>("24H");
  const momentumTitle = selectedWindow === "24H" ? "Live momentum" : "Sustained momentum";
  const momentumEmptyMessage = selectedWindow === "24H"
    ? "No 24H momentum cards yet"
    : "No 7D momentum cards yet";

  return (
    <>
      <SignalRailSection
        id="top-movers"
        eyebrow="Live Market"
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
}: {
  id: string;
  eyebrow: string;
  eyebrowClassName: string;
  title: string;
  cards: HomepageCard[];
  emptyMessage: string;
  headerSlot?: ReactNode;
  spacingClassName?: string;
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
            <Link href="/search" className="text-[13px] font-medium text-[#00B4D8] transition-colors hover:text-white">
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

function SignalCard({ card }: { card: HomepageCard }) {
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
        <div className="mt-2 flex items-center justify-between border-t border-white/[0.04] pt-2">
          <span className="text-[15px] font-bold tabular-nums text-white">{formatPrice(card.market_price)}</span>
          <span className={`rounded-md px-1.5 py-0.5 text-[12px] font-bold tabular-nums ${(card.change_pct ?? 0) >= 0 ? "bg-[#00DC5A]/10 text-[#00DC5A]" : "bg-[#FF3B30]/10 text-[#FF3B30]"}`}>
            {formatPct(card.change_pct)}
          </span>
        </div>
      </div>
    </Link>
  );
}
