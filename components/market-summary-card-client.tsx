"use client";

import { useEffect, useState } from "react";

import { GroupCard, GroupedSection, Pill, StatRow } from "@/components/ios-grouped-ui";

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

function formatDateLabel(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
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

function formatUpdatedLabel(value: string | null): string {
  if (!value) return "—";
  const relative = formatRelativeTime(value);
  if (!relative) return formatDateLabel(value);
  return `${relative} • ${formatDateLabel(value)}`;
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

function buildSparklinePath(points: HistoryPointRow[]): string | null {
  if (points.length < 2) return null;
  const values = points.map((point) => point.price).filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;

  const width = 280;
  const height = 78;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);

  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
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
  const sparklinePath = buildSparklinePath(chartSeries);
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
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px] font-semibold text-[#F0F0F0]">Market Summary</p>
            <div className="flex items-center gap-2">
              <Pill label="RAW cache" tone="neutral" size="small" />
              <div className="grid min-w-[168px] auto-cols-fr grid-flow-col gap-1 rounded-2xl border border-[#1E1E1E] bg-[#151515] p-1">
                {(["7d", "30d", "90d"] as WindowKey[]).map((windowKey) => {
                  const active = activeWindow === windowKey;
                  return (
                    <button
                      key={windowKey}
                      type="button"
                      onClick={() => setWindow(windowKey)}
                      className={[
                        "flex min-h-11 items-center justify-center rounded-xl px-3 text-center text-[13px] font-semibold transition",
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
          </div>
        }
      >
        {currentPrice === null ? (
          <div className="rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-5 text-[14px] text-[#777]">
            No market data yet.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(220px,0.8fr)]">
            <div className="rounded-2xl border border-[#1E1E1E] bg-[#151515] p-4 sm:p-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">Current Price</p>
              <div className="mt-2 text-[30px] font-semibold tracking-[-0.03em] text-[#F0F0F0]">{formatUsd(currentPrice)}</div>
              <div className="mt-4 divide-y divide-[#1E1E1E] rounded-2xl border border-[#1E1E1E] bg-[#1A1A1A] px-4">
                <StatRow label="Updated" value={formatUpdatedLabel(asOfTs)} />
                <StatRow label={`Samples (${effectiveWindow.toUpperCase()})`} value={sampleCount > 0 ? String(sampleCount) : "—"} />
              </div>
              <div className="mt-4 divide-y divide-[#1E1E1E] rounded-2xl border border-[#1E1E1E] bg-[#1A1A1A] px-4">
                <StatRow label={`${effectiveWindow.toUpperCase()} Change`} value={formatPercent(changeValue)} />
                <StatRow label={`${effectiveWindow.toUpperCase()} Low`} value={formatUsd(low)} />
                <StatRow label={`${effectiveWindow.toUpperCase()} High`} value={formatUsd(high)} />
              </div>
            </div>

            <div className="rounded-2xl border border-[#1E1E1E] bg-[#151515] p-4 sm:p-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">{effectiveWindow.toUpperCase()} Trend</p>
              {sparklinePath ? (
                <svg viewBox="0 0 280 78" className="mt-4 h-24 w-full" role="img" aria-label={`${effectiveWindow} price sparkline`} preserveAspectRatio="none">
                  <path
                    d={sparklinePath}
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <div className="mt-4 flex h-24 items-center justify-center rounded-2xl border border-dashed border-white/[0.08] text-[14px] text-[#777]">
                  No market data yet.
                </div>
              )}
            </div>
          </div>
        )}
      </GroupCard>
    </GroupedSection>
  );
}
