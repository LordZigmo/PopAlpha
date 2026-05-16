"use client";

import { useMarket, type Market } from "@/lib/market-context";

const SEGMENTS: ReadonlyArray<{
  market: Market;
  label: string;
  accessibilityLabel: string;
  fill: string;
}> = [
  { market: "EN", label: "EN", accessibilityLabel: "English market", fill: "#00B4D8" },
  { market: "JP", label: "JP", accessibilityLabel: "Japanese market", fill: "#BC002D" },
];

export default function MarketTogglePill() {
  const { market, setMarket } = useMarket();

  return (
    <div
      role="group"
      aria-label="Market"
      className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.04] p-0.5"
    >
      {SEGMENTS.map((seg) => {
        const isActive = market === seg.market;
        return (
          <button
            key={seg.market}
            type="button"
            aria-pressed={isActive}
            aria-label={seg.accessibilityLabel}
            onClick={() => {
              if (market !== seg.market) setMarket(seg.market);
            }}
            className="relative flex h-6 w-8 items-center justify-center rounded-full text-[11px] font-semibold tracking-[0.08em] transition-colors"
            style={{
              backgroundColor: isActive ? seg.fill : "transparent",
              color: isActive ? "#ffffff" : "#9CA3AF",
            }}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
