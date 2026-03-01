"use client";

import { useCallback, useRef, useState } from "react";

type ChartPoint = { ts: string; price: number };

type EnhancedChartProps = {
  points: ChartPoint[];
  windowLabel?: string;
  currentPrice?: number | null;
  changePercent?: number | null;
};

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatChartDate(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

const SVG_W = 600;
const SVG_H = 200;
const PAD_X = 0;
const PAD_Y = 10;

export default function EnhancedChart({
  points,
  windowLabel,
  currentPrice,
  changePercent,
}: EnhancedChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; price: number; ts: string } | null>(null);

  const prices = points.map((p) => p.price).filter((v) => Number.isFinite(v));
  const min = prices.length > 0 ? Math.min(...prices) : 0;
  const max = prices.length > 0 ? Math.max(...prices) : 1;
  const range = Math.max(max - min, 0.01);

  const toX = useCallback(
    (i: number) => PAD_X + (i / Math.max(points.length - 1, 1)) * (SVG_W - PAD_X * 2),
    [points.length],
  );
  const toY = useCallback(
    (price: number) => PAD_Y + (1 - (price - min) / range) * (SVG_H - PAD_Y * 2),
    [min, range],
  );

  const linePath =
    points.length >= 2
      ? points
          .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.price).toFixed(1)}`)
          .join(" ")
      : null;

  const areaPath = linePath
    ? `${linePath} L ${toX(points.length - 1).toFixed(1)} ${SVG_H} L ${toX(0).toFixed(1)} ${SVG_H} Z`
    : null;

  // Grid lines at 25%, 50%, 75%
  const gridYs = [0.25, 0.5, 0.75].map((pct) => ({
    y: PAD_Y + pct * (SVG_H - PAD_Y * 2),
    price: max - pct * range,
  }));

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || points.length < 2) return;
      const rect = svgRef.current.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width;
      const idx = Math.round(relX * (points.length - 1));
      const clamped = Math.max(0, Math.min(idx, points.length - 1));
      const pt = points[clamped];
      if (pt) {
        setHover({ x: toX(clamped), y: toY(pt.price), price: pt.price, ts: pt.ts });
      }
    },
    [points, toX, toY],
  );

  const handleMouseLeave = useCallback(() => setHover(null), []);

  if (points.length < 2) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-2xl border border-dashed border-white/[0.08] text-[16px] text-[#777] sm:h-[260px]">
        Not enough data to chart.
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Header row */}
      {(windowLabel || currentPrice != null) && (
        <div className="mb-2 flex items-baseline justify-between gap-3">
          {windowLabel && (
            <p className="text-[14px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">
              {windowLabel} Trend
            </p>
          )}
          {currentPrice != null && (
            <div className="flex items-baseline gap-2">
              <span className="text-[17px] font-semibold tabular-nums text-[#F0F0F0]">
                {formatUsd(currentPrice)}
              </span>
              {changePercent != null && Number.isFinite(changePercent) && (
                <span
                  className={`text-[15px] font-semibold tabular-nums ${changePercent > 0 ? "text-[#00DC5A]" : changePercent < 0 ? "text-[#FF3B30]" : "text-[#6B6B6B]"}`}
                >
                  {changePercent > 0 ? "+" : ""}
                  {Math.abs(changePercent) >= 10 ? changePercent.toFixed(0) : changePercent.toFixed(1)}%
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className="w-full h-[200px] sm:h-[260px]"
        preserveAspectRatio="none"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id="chart-fill-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {gridYs.map((g) => (
          <line
            key={g.y}
            x1={PAD_X}
            y1={g.y}
            x2={SVG_W - PAD_X}
            y2={g.y}
            stroke="#1E1E1E"
            strokeWidth="1"
          />
        ))}

        {/* Gradient fill */}
        {areaPath && (
          <path d={areaPath} fill="url(#chart-fill-grad)" className="chart-gradient-fill" />
        )}

        {/* Line */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* Crosshair on hover */}
        {hover && (
          <g className="chart-crosshair">
            <line x1={hover.x} y1={PAD_Y} x2={hover.x} y2={SVG_H} stroke="#555" strokeWidth="1" strokeDasharray="4 3" />
            <circle cx={hover.x} cy={hover.y} r="4" fill="var(--color-accent)" stroke="#0A0A0A" strokeWidth="2" />
          </g>
        )}
      </svg>

      {/* Y-axis labels */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between py-[5%]">
        <span className="text-[12px] font-tabular text-[#555] pl-1">{formatUsd(max)}</span>
        <span className="text-[12px] font-tabular text-[#555] pl-1">{formatUsd(min)}</span>
      </div>

      {/* Hover tooltip */}
      {hover && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-[#1E1E1E] bg-[#151515] px-2.5 py-1.5 text-[14px] shadow-lg"
          style={{
            left: `${(hover.x / SVG_W) * 100}%`,
            transform: "translateX(-50%)",
          }}
        >
          <span className="font-semibold tabular-nums text-[#F0F0F0]">{formatUsd(hover.price)}</span>
          <span className="ml-2 text-[#6B6B6B]">{formatChartDate(hover.ts)}</span>
        </div>
      )}
    </div>
  );
}
