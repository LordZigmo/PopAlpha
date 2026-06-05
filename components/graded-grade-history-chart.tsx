"use client";

import { useMemo, useState } from "react";

import MultiLineChart, { type MultiLineSeries, type MultiLineScale } from "@/components/multi-line-chart";
import type { GradeBucket } from "@/lib/cards/detail-types";
import type { GradedGradeSeries } from "@/lib/cards/graded-grade-history";

type GradedGradeHistoryChartProps = {
  series: GradedGradeSeries[];
  providerLabel: string;
  selectedWindow: "7d" | "30d" | "90d";
};

const GRADE_COLOR: Record<GradeBucket, string> = {
  G10_PERFECT: "#F472B6",
  G10: "#34D399",
  G9_5: "#60A5FA",
  G9: "#A78BFA",
  G8: "#FBBF24",
  LE_7: "#FB7185",
};

const GRADE_LABEL: Record<GradeBucket, string> = {
  G10_PERFECT: "10 Perfect",
  G10: "10",
  G9_5: "9.5",
  G9: "9",
  G8: "8",
  LE_7: "7 or less",
};

type WindowKey = "30d" | "90d";

function windowCutoffMs(windowKey: WindowKey): number {
  const days = windowKey === "90d" ? 90 : 30;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function filterPoints(points: { ts: string; price: number }[], windowKey: WindowKey) {
  const cutoff = windowCutoffMs(windowKey);
  return points.filter((p) => {
    const ts = Date.parse(p.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

export default function GradedGradeHistoryChart({
  series,
  providerLabel,
  selectedWindow,
}: GradedGradeHistoryChartProps) {
  const [scale, setScale] = useState<MultiLineScale>("indexed");
  const [windowKey, setWindowKey] = useState<WindowKey>(selectedWindow === "90d" ? "90d" : "30d");

  const chartSeries = useMemo<MultiLineSeries[]>(() => {
    return series
      .map((s) => ({
        key: s.grade,
        label: GRADE_LABEL[s.grade] ?? s.grade,
        color: GRADE_COLOR[s.grade] ?? "#9A9A9A",
        points: filterPoints(s.points, windowKey),
      }))
      .filter((s) => s.points.length >= 2);
  }, [series, windowKey]);

  if (series.length === 0) return null;

  return (
    <section className="mt-6 rounded-[20px] border border-[#1E1E1E] bg-[#101010] px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[17px] font-semibold text-[#F0F0F0]">Grade Performance</p>
          <p className="mt-0.5 text-[13px] text-[#6B6B6B]">
            {providerLabel} grades ·{" "}
            {scale === "indexed"
              ? "indexed to start of window — compare relative momentum"
              : "observed market prices"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Scale toggle: % (indexed) vs $ (absolute) */}
          <div className="inline-flex rounded-full border border-white/[0.08] bg-[#0D0D0D] p-0.5">
            {(["indexed", "absolute"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setScale(mode)}
                className={[
                  "rounded-full px-3 py-1 text-[13px] font-semibold transition-colors",
                  scale === mode ? "bg-[#2b313d] text-[#F0F0F0]" : "text-[#777]",
                ].join(" ")}
                aria-pressed={scale === mode}
              >
                {mode === "indexed" ? "%" : "$"}
              </button>
            ))}
          </div>
          {/* Window toggle */}
          <div className="inline-flex rounded-full border border-white/[0.08] bg-[#0D0D0D] p-0.5">
            {(["30d", "90d"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setWindowKey(key)}
                className={[
                  "rounded-full px-3 py-1 text-[13px] font-semibold uppercase transition-colors",
                  windowKey === key ? "bg-[#2b313d] text-[#F0F0F0]" : "text-[#777]",
                ].join(" ")}
                aria-pressed={windowKey === key}
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        {chartSeries.length > 0 ? (
          <MultiLineChart series={chartSeries} scale={scale} />
        ) : (
          <div className="flex h-[200px] items-center justify-center rounded-2xl border border-dashed border-white/[0.06] text-[15px] text-[#777]">
            Not enough graded history in this window yet.
          </div>
        )}
      </div>
    </section>
  );
}
