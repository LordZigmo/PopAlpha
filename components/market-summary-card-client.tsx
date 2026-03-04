"use client";

import { useEffect, useRef, useState } from "react";

import { GroupCard, GroupedSection } from "@/components/ios-grouped-ui";
import PriceTickerStrip from "@/components/price-ticker-strip";
import EnhancedChart from "@/components/enhanced-chart";

type HistoryPointRow = {
  ts: string;
  price: number;
};

type MarketSummaryCardClientProps = {
  variants: Array<{
    printingId: string;
    label: string;
    currentPrice: number | null;
    asOfTs: string | null;
    trendSlope7d?: number | null;
    history7d: HistoryPointRow[];
    history30d: HistoryPointRow[];
    history90d: HistoryPointRow[];
  }>;
  selectedPrintingId: string | null;
  selectedWindow: "7d" | "30d" | "90d";
  onVariantChange?: (printingId: string) => void;
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

const WINDOWS: WindowKey[] = ["7d", "30d", "90d"];

function WindowTabs({ active, onChange }: { active: WindowKey; onChange: (w: WindowKey) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const activeIndex = WINDOWS.indexOf(active);

  return (
    <div
      ref={trackRef}
      className="relative grid auto-cols-fr grid-flow-col gap-0 rounded-2xl border border-white/[0.06] bg-[#0D0D0D] p-1"
    >
      {/* Sliding background pill */}
      <div
        className="sliding-pill-bg"
        style={{
          width: `calc(${100 / WINDOWS.length}% - 0px)`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {WINDOWS.map((windowKey) => {
        const isActive = active === windowKey;
        return (
          <button
            key={windowKey}
            type="button"
            onClick={() => onChange(windowKey)}
            className={[
              "relative z-10 flex min-h-11 items-center justify-center rounded-xl px-3 text-center text-[15px] font-semibold transition-colors duration-150",
              isActive ? "text-[#F0F0F0]" : "text-[#555]",
            ].join(" ")}
          >
            {windowKey.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

export default function MarketSummaryCardClient({
  variants,
  selectedPrintingId,
  selectedWindow,
  onVariantChange,
}: MarketSummaryCardClientProps) {
  const [activeWindow, setActiveWindow] = useState<WindowKey>(selectedWindow);

  useEffect(() => {
    setActiveWindow(selectedWindow);
  }, [selectedWindow]);

  const activeVariant =
    variants.find((variant) => variant.printingId === selectedPrintingId)
    ?? variants[0]
    ?? null;

  const currentPrice = activeVariant?.currentPrice ?? null;
  const asOfTs = activeVariant?.asOfTs ?? null;
  const history7d = activeVariant?.history7d ?? [];
  const history30d = activeVariant?.history30d ?? [];
  const history90d = activeVariant?.history90d ?? [];

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

  function setVariant(nextPrintingId: string) {
    onVariantChange?.(nextPrintingId);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("printing", nextPrintingId);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <GroupedSection>
      <GroupCard
        className="glass-target"
        header={
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
              <p className="text-[22px] font-semibold text-[#F0F0F0]">Market Summary</p>
              <WindowTabs active={activeWindow} onChange={setWindow} />
            </div>
          </div>
        }
      >
        {currentPrice === null ? (
          <div className="rounded-2xl border border-white/[0.06] bg-[#151515] px-4 py-5 text-[16px] text-[#777]">
            No market data yet.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Hero price */}
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#F0F0F0] sm:text-[44px]">
                {formatUsd(currentPrice)}
              </span>
              <span className="shrink-0 text-[14px] text-[#6B6B6B]">
                {formatRelativeTime(asOfTs) ?? ""}
              </span>
            </div>

            {/* Chart */}
            <EnhancedChart
              points={chartSeries}
              windowLabel={effectiveWindow.toUpperCase()}
              currentPrice={currentPrice}
              changePercent={changeValue}
            />

            <div className="border-t border-white/[0.06]" />

            {/* Stats table — 2×2, change cell last (bottom-right) */}
            <PriceTickerStrip
              items={[
                { label: `${effectiveWindow.toUpperCase()} Low`, value: formatUsd(low) },
                { label: `${effectiveWindow.toUpperCase()} High`, value: formatUsd(high) },
                { label: "Sales", value: sampleCount > 0 ? String(sampleCount) : "—" },
                { label: `${effectiveWindow.toUpperCase()} Change`, value: formatPercent(changeValue), tone: changeTone(changeValue) },
              ]}
            />

            {variants.length > 1 ? (
              <>
                <div className="border-t border-white/[0.06]" />
                <div className="flex flex-wrap gap-2">
                  {variants.map((variant) => {
                    const active = variant.printingId === (activeVariant?.printingId ?? null);
                    return (
                      <button
                        key={variant.printingId}
                        type="button"
                        onClick={() => setVariant(variant.printingId)}
                        className={[
                          "inline-flex min-h-10 items-center rounded-full border px-3 text-[14px] font-semibold transition-all duration-150",
                          active
                            ? "border-white/[0.1] bg-[#222] text-[#F0F0F0] shadow-[0_2px_8px_rgba(0,0,0,0.2)]"
                            : "border-white/[0.04] bg-transparent text-[#555]",
                        ].join(" ")}
                      >
                        {variant.label}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        )}
      </GroupCard>
    </GroupedSection>
  );
}
