"use client";

import { useCallback, useMemo, useRef, useState } from "react";

export type MultiLineSeries = {
  /** Stable key for React + hover lookups. */
  key: string;
  /** Legend label, e.g. "Unlimited", "1st Edition", "PSA 10". */
  label: string;
  /** Stroke color (any CSS color or var()). */
  color: string;
  points: { ts: string; price: number }[];
};

export type MultiLineScale = "absolute" | "indexed";

type MultiLineChartProps = {
  series: MultiLineSeries[];
  /**
   * "absolute" plots real prices on a shared $ axis.
   * "indexed" rebases each series to 100 at its first in-window point so
   * relative momentum is comparable across wildly different price levels
   * (e.g. PSA 10 ~$3.7K vs PSA 7 ~$210).
   */
  scale?: MultiLineScale;
  heightClass?: string;
};

const SVG_W = 600;
const SVG_H = 200;
const PAD_Y = 12;

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatIndexDelta(indexValue: number): string {
  const delta = indexValue - 100;
  const abs = Math.abs(delta);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${delta > 0 ? "+" : delta < 0 ? "-" : ""}${formatted}%`;
}

function formatChartDate(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

type PreparedSeries = MultiLineSeries & {
  /** [{ tsMs, value }] where value is price (absolute) or index (indexed). */
  values: { tsMs: number; value: number; price: number }[];
};

export default function MultiLineChart({
  series,
  scale = "absolute",
  heightClass = "h-[200px] sm:h-[260px]",
}: MultiLineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverTsMs, setHoverTsMs] = useState<number | null>(null);

  const prepared = useMemo<PreparedSeries[]>(() => {
    return series
      .map((s) => {
        const sorted = [...s.points]
          .map((p) => ({ tsMs: Date.parse(p.ts), price: p.price }))
          .filter((p) => Number.isFinite(p.tsMs) && Number.isFinite(p.price) && p.price > 0)
          .sort((a, b) => a.tsMs - b.tsMs);
        const base = sorted[0]?.price ?? null;
        const values = sorted.map((p) => ({
          tsMs: p.tsMs,
          price: p.price,
          value: scale === "indexed" && base && base > 0 ? (p.price / base) * 100 : p.price,
        }));
        return { ...s, values };
      })
      .filter((s) => s.values.length >= 2);
  }, [series, scale]);

  const domain = useMemo(() => {
    const allTs = prepared.flatMap((s) => s.values.map((v) => v.tsMs));
    const allVals = prepared.flatMap((s) => s.values.map((v) => v.value));
    const minTs = allTs.length ? Math.min(...allTs) : 0;
    const maxTs = allTs.length ? Math.max(...allTs) : 1;
    const minVal = allVals.length ? Math.min(...allVals) : 0;
    const maxVal = allVals.length ? Math.max(...allVals) : 1;
    return {
      minTs,
      maxTs,
      tsRange: Math.max(maxTs - minTs, 1),
      minVal,
      maxVal,
      valRange: Math.max(maxVal - minVal, 0.01),
    };
  }, [prepared]);

  const toX = useCallback(
    (tsMs: number) => ((tsMs - domain.minTs) / domain.tsRange) * SVG_W,
    [domain.minTs, domain.tsRange],
  );
  const toY = useCallback(
    (value: number) => PAD_Y + (1 - (value - domain.minVal) / domain.valRange) * (SVG_H - PAD_Y * 2),
    [domain.minVal, domain.valRange],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      const clamped = Math.max(0, Math.min(1, frac));
      setHoverTsMs(domain.minTs + clamped * domain.tsRange);
    },
    [domain.minTs, domain.tsRange],
  );
  const handleMouseLeave = useCallback(() => setHoverTsMs(null), []);

  // For the hovered timestamp, the nearest in-window point of each series.
  const hoverReadout = useMemo(() => {
    if (hoverTsMs === null) return null;
    const rows = prepared
      .map((s) => {
        let nearest = s.values[0];
        let bestDelta = Infinity;
        for (const v of s.values) {
          const delta = Math.abs(v.tsMs - hoverTsMs);
          if (delta < bestDelta) {
            bestDelta = delta;
            nearest = v;
          }
        }
        return nearest ? { key: s.key, label: s.label, color: s.color, point: nearest } : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
    if (rows.length === 0) return null;
    const x = toX(hoverTsMs);
    return { x, rows, tsMs: hoverTsMs };
  }, [hoverTsMs, prepared, toX]);

  if (prepared.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-2xl border border-dashed border-white/[0.06] text-[16px] text-[#777] sm:h-[260px]">
        Not enough data to chart.
      </div>
    );
  }

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((pct) => PAD_Y + pct * (SVG_H - PAD_Y * 2));
  const topLabel = scale === "indexed" ? formatIndexDelta(domain.maxVal) : formatUsd(domain.maxVal);
  const bottomLabel = scale === "indexed" ? formatIndexDelta(domain.minVal) : formatUsd(domain.minVal);

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className={`w-full ${heightClass}`}
        preserveAspectRatio="none"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Grid */}
        {gridYs.map((y) => (
          <line key={y} x1={0} y1={y} x2={SVG_W} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
        ))}

        {/* Indexed baseline (100) */}
        {scale === "indexed" && domain.minVal <= 100 && domain.maxVal >= 100 ? (
          <line
            x1={0}
            y1={toY(100)}
            x2={SVG_W}
            y2={toY(100)}
            stroke="rgba(255,255,255,0.14)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ) : null}

        {/* Series lines */}
        {prepared.map((s) => {
          const d = s.values
            .map((v, i) => `${i === 0 ? "M" : "L"} ${toX(v.tsMs).toFixed(1)} ${toY(v.value).toFixed(1)}`)
            .join(" ");
          return (
            <path
              key={s.key}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {/* Hover crosshair + per-series dots */}
        {hoverReadout ? (
          <g>
            <line
              x1={hoverReadout.x}
              y1={PAD_Y}
              x2={hoverReadout.x}
              y2={SVG_H}
              stroke="rgba(255,255,255,0.12)"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            {hoverReadout.rows.map((row) => (
              <circle
                key={row.key}
                cx={toX(row.point.tsMs)}
                cy={toY(row.point.value)}
                r="4"
                fill={row.color}
                stroke="#0A0A0A"
                strokeWidth="2"
              />
            ))}
          </g>
        ) : null}
      </svg>

      {/* Y-axis labels */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between py-[6px]">
        <span className="pl-1 text-[12px] tabular-nums text-[#444]">{topLabel}</span>
        <span className="pl-1 text-[12px] tabular-nums text-[#444]">{bottomLabel}</span>
      </div>

      {/* Hover tooltip */}
      {hoverReadout ? (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-white/[0.08] bg-[#151515] px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${(hoverReadout.x / SVG_W) * 100}%`,
            transform: `translateX(${hoverReadout.x > SVG_W * 0.6 ? "-100%" : "-50%"})`,
          }}
        >
          <div className="mb-1 text-[11px] text-[#6B6B6B]">{formatChartDate(new Date(hoverReadout.tsMs).toISOString())}</div>
          <div className="flex flex-col gap-0.5">
            {hoverReadout.rows.map((row) => (
              <div key={row.key} className="flex items-center gap-2 text-[13px]">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
                <span className="text-[#9A9A9A]">{row.label}</span>
                <span className="ml-auto font-semibold tabular-nums text-[#F0F0F0]">
                  {formatUsd(row.point.price)}
                  {scale === "indexed" ? (
                    <span className="ml-1 text-[11px] font-normal text-[#6B6B6B]">{formatIndexDelta(row.point.value)}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
        {prepared.map((s) => {
          const last = s.values[s.values.length - 1];
          return (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3.5 rounded" style={{ backgroundColor: s.color }} aria-hidden="true" />
              <span className="text-[#9A9A9A]">{s.label}</span>
              {last ? (
                <span className="tabular-nums text-[#6B6B6B]">
                  {scale === "indexed" ? formatIndexDelta(last.value) : formatUsd(last.price)}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
