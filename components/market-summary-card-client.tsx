"use client";

import { useEffect, useState } from "react";

import { GroupCard, GroupedSection } from "@/components/ios-grouped-ui";
import PriceTickerStrip from "@/components/price-ticker-strip";
import EnhancedChart from "@/components/enhanced-chart";

type HistoryPointRow = {
  ts: string;
  price: number;
};

type MarketSummaryCardClientProps = {
  currentPrice: number | null;
  asOfTs: string | null;
  selectedWindow: "7d" | "30d" | "90d";
  history7d: HistoryPointRow[];
  history30d: HistoryPointRow[];
  history90d: HistoryPointRow[];
};

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${rounded}%`;
}

function formatRelativeTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function computeChange(points: HistoryPointRow[]): number | null {
  if (points.length < 2) return null;
  const first = points[0]?.price;
  const last = points[points.length - 1]?.price;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  return ((last - first) / first) * 100;
}

function computeLowHigh(points: HistoryPointRow[]): { low: number | null; high: number | null } {
  if (points.length === 0) return { low: null, high: null };
  const prices = points.map((point) => point.price).filter((value) => Number.isFinite(value));
  if (prices.length === 0) return { low: null, high: null };
  return { low: Math.min(...prices), high: Math.max(...prices) };
}

function changeTone(value: number | null): "neutral" | "positive" | "negative" {
  if (value === null || !Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

type WindowKey = "7d" | "30d" | "90d";

export default function MarketSummaryCardClient({
  currentPrice,
  asOfTs,
  selectedWindow,
  history7d,
  history30d,
  history90d,
}: MarketSummaryCardClientProps) {
  const [activeWindow, setActiveWindow] = useState<WindowKey>(selectedWindow);

  useEffect(() => {
    setActiveWindow(selectedWindow);
  }, [selectedWindow]);

  const chartSeries =
    activeWindow === "90d" && history90d.length > 0
      ? history90d
      : activeWindow === "7d" && history7d.length > 0
        ? history7d
        : history30d;
  const effectiveWindow: WindowKey =
    activeWindow === "90d" && history90d.length > 0
      ? "90d"
      : activeWindow === "7d" && history7d.length > 0
        ? "7d"
        : "30d";

  const changeValue = computeChange(chartSeries);
  const { low, high } = computeLowHigh(chartSeries);
  const sampleCount = chartSeries.length;

  function setWindow(nextWindow: WindowKey) {
    setActiveWindow(nextWindow);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (nextWindow === "30d") url.searchParams.delete("marketWindow");
    else url.searchParams.set("marketWindow", nextWindow);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <GroupedSection>
      <GroupCard
        header={
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
            <p className="text-[20px] font-semibold text-[#F0F0F0]">Market Summary</p>
            <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-2xl border border-[#1E1E1E] bg-[#151515] p-1">
              {(["7d", "30d", "90d"] as WindowKey[]).map((windowKey) => {
                const active = activeWindow === windowKey;
                return (
                  <button
                    key={windowKey}
                    type="button"
                    onClick={() => setWindow(windowKey)}
                    className={[
                      "flex min-h-11 items-center justify-center rounded-xl px-3 text-center text-[15px] font-semibold transition",
                      active
                        ? "bg-[#222] text-[#F0F0F0] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                        : "text-[#777]",
                    ].join(" ")}
                  >
                    {windowKey.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>
        }
      >
        {currentPrice === null ? (
          <div className="rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-5 text-[16px] text-[#777]">
            No market data yet.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Hero price */}
            <div className="flex flex-wrap items-baseline gap-2.5">
              <span className="text-[36px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#F0F0F0] sm:text-[42px]">
                {formatUsd(currentPrice)}
              </span>
              {changeValue !== null && Number.isFinite(changeValue) && (
                <span className={`text-[18px] font-semibold tabular-nums sm:text-[20px] ${changeValue > 0 ? "text-[#00DC5A]" : changeValue < 0 ? "text-[#FF3B30]" : "text-[#6B6B6B]"}`}>
                  {formatPercent(changeValue)}
                </span>
              )}
              <span className="text-[14px] text-[#6B6B6B]">
                {formatRelativeTime(asOfTs) ?? ""}
              </span>
            </div>

            {/* Secondary stats */}
            <PriceTickerStrip
              items={[
                { label: `${effectiveWindow.toUpperCase()} Low`, value: formatUsd(low) },
                { label: `${effectiveWindow.toUpperCase()} High`, value: formatUsd(high) },
                { label: "Samples", value: sampleCount > 0 ? String(sampleCount) : "—" },
              ]}
            />

            <EnhancedChart
              points={chartSeries}
              windowLabel={effectiveWindow.toUpperCase()}
              currentPrice={currentPrice}
              changePercent={changeValue}
            />
          </div>
        )}
      </GroupCard>
    </GroupedSection>
  );
}
