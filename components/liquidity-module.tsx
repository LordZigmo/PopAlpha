"use client";

import { useState } from "react";

import { GroupCard, Pill } from "@/components/ios-grouped-ui";

type LiquidityModuleProps = {
  score: number | null;
  tier: string | null;
  tone: "warning" | "neutral" | "positive";
  priceChanges30d: number | null;
  snapshotCount30d: number | null;
  spreadPercent: number | null;
};

const BAR_COLORS: Record<string, string> = {
  Illiquid: "#B8860B",
  Thin: "#888",
  Active: "#6B9BD2",
  "Highly Liquid": "#00DC5A",
};

function barColor(tier: string | null): string {
  if (!tier) return "#888";
  return BAR_COLORS[tier] ?? "#888";
}

export default function LiquidityModule({
  score,
  tier,
  tone,
  priceChanges30d,
  snapshotCount30d,
  spreadPercent,
}: LiquidityModuleProps) {
  const [expanded, setExpanded] = useState(false);

  const hasData = score !== null;
  const displayScore = hasData ? score : null;
  const displayTier = hasData ? tier : "Insufficient data";
  const displayTone = hasData ? tone : "neutral";
  const canExpand = hasData;

  const velocity = priceChanges30d !== null
    ? (priceChanges30d / 30).toFixed(2)
    : "\u2014";

  const detailRows = [
    { label: "30d Sales", value: priceChanges30d !== null ? String(priceChanges30d) : "\u2014" },
    { label: "Velocity", value: priceChanges30d !== null ? `${velocity} / day` : "\u2014" },
    { label: "Spread", value: spreadPercent !== null ? `${spreadPercent}%` : "\u2014" },
    { label: "Data Density", value: snapshotCount30d !== null ? `${snapshotCount30d} / 30 days` : "\u2014" },
  ];

  return (
    <div className="fade-slide-up mt-8">
      <GroupCard className="glass-target">
        {/* Header row — tappable */}
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3"
          onClick={() => canExpand && setExpanded((prev) => !prev)}
          disabled={!canExpand}
          aria-expanded={expanded}
        >
          <p className="text-[17px] font-semibold text-[#F0F0F0]">Liquidity Score</p>
          <div className="flex items-center gap-2">
            <Pill label={displayTier ?? "\u2014"} tone={displayTone} size="small" />
            {canExpand && (
              <span
                className="inline-flex text-[#6B6B6B] transition-transform duration-300"
                style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
          </div>
        </button>

        {/* Score bar */}
        {hasData ? (
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 h-[4px] rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${displayScore}%`,
                  backgroundColor: barColor(tier),
                }}
              />
            </div>
            <span className="shrink-0 text-[15px] font-semibold tabular-nums text-[#999]">
              {displayScore} <span className="text-[#555]">/ 100</span>
            </span>
          </div>
        ) : (
          <p className="mt-3 text-[15px] tabular-nums text-[#555]">{"\u2014"}</p>
        )}

        {/* Accordion details */}
        <div
          className="transition-[grid-template-rows] duration-300 ease-in-out"
          style={{
            display: "grid",
            gridTemplateRows: expanded ? "1fr" : "0fr",
          }}
        >
          <div className="overflow-hidden">
            <div className="pt-4 space-y-0 divide-y divide-white/[0.06]">
              {detailRows.map((row) => (
                <div key={row.label} className="flex items-center justify-between py-2.5">
                  <span className="text-[15px] text-[#999]">{row.label}</span>
                  <span className="text-[15px] font-semibold tabular-nums text-[#F0F0F0]">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </GroupCard>
    </div>
  );
}
