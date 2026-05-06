"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import type { SharedPrivateSale } from "@/lib/data/shared-private-sales";

type ChartPoint = { ts: string; price: number };

type EnhancedChartProps = {
  points: ChartPoint[];
  windowLabel?: string;
  currentPrice?: number | null;
  changePercent?: number | null;
  /**
   * Anonymous opt-in private-sale data points overlaid as dots on the
   * existing market line. Each dot is `{date, priceUsd}` from a holder
   * who chose "share with the community" when adding their lot. Only
   * dots whose date falls inside the visible window get rendered.
   */
  sharedSales?: SharedPrivateSale[];
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
  currentPrice,
  changePercent,
  sharedSales,
}: EnhancedChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; price: number; ts: string } | null>(null);
  const [hoverDot, setHoverDot] = useState<{ x: number; y: number; price: number; date: string } | null>(null);

  // Y range needs to accommodate both the market line AND the shared-
  // sale dots so an outlier-but-in-band sale doesn't clip the chart.
  const sharedSalePrices = (sharedSales ?? [])
    .map((sale) => sale.priceUsd)
    .filter((value) => Number.isFinite(value) && value > 0);
  const prices = [
    ...points.map((p) => p.price).filter((v) => Number.isFinite(v)),
    ...sharedSalePrices,
  ];
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

  // Grid lines at 25%, 50%, 75% — reduced opacity
  const gridYs = [0.25, 0.5, 0.75].map((pct) => ({
    y: PAD_Y + pct * (SVG_H - PAD_Y * 2),
    price: max - pct * range,
  }));

  // Last point for emphasis
  const lastPoint = points.length >= 2 ? points[points.length - 1] : null;
  const lastX = lastPoint ? toX(points.length - 1) : 0;
  const lastY = lastPoint ? toY(lastPoint.price) : 0;

  // Map each shared sale's date onto the chart's X axis by linear
  // interpolation against the visible window's first/last timestamps.
  // Sales outside the window are dropped. The chart's existing X axis
  // is positional (i / N), so this approximation matches the visual
  // density of the market line for daily snapshots.
  const visibleSharedSales = useMemo(() => {
    if (!sharedSales || sharedSales.length === 0 || points.length < 2) return [];
    const firstTs = Date.parse(points[0].ts);
    const lastTs = Date.parse(points[points.length - 1].ts);
    if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs) || lastTs <= firstTs) return [];
    const span = lastTs - firstTs;
    return sharedSales
      .map((sale) => {
        const ts = Date.parse(sale.date);
        if (!Number.isFinite(ts)) return null;
        if (ts < firstTs || ts > lastTs) return null;
        const fraction = (ts - firstTs) / span;
        const x = PAD_X + fraction * (SVG_W - PAD_X * 2);
        const y = toY(sale.priceUsd);
        return { x, y, price: sale.priceUsd, date: sale.date };
      })
      .filter((value): value is { x: number; y: number; price: number; date: string } => value !== null);
  }, [sharedSales, points, toY]);

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
      <div className="flex h-[200px] items-center justify-center rounded-2xl border border-dashed border-white/[0.06] text-[16px] text-[#777] sm:h-[260px]">
        Not enough data to chart.
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Header row — price + change */}
      {currentPrice != null && (
        <div className="mb-3 flex items-baseline justify-end gap-2.5">
          <span className="text-[17px] font-semibold tabular-nums text-[#F0F0F0]">
            {formatUsd(currentPrice)}
          </span>
          {changePercent != null && Number.isFinite(changePercent) && (
            <span
              className={`text-[17px] font-bold tabular-nums ${changePercent > 0 ? "text-[#00DC5A]" : changePercent < 0 ? "text-[#FF3B30]" : "text-[#6B6B6B]"}`}
            >
              {changePercent > 0 ? "+" : ""}
              {Math.abs(changePercent) >= 10 ? changePercent.toFixed(0) : changePercent.toFixed(1)}%
            </span>
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

        {/* Grid lines — reduced opacity */}
        {gridYs.map((g) => (
          <line
            key={g.y}
            x1={PAD_X}
            y1={g.y}
            x2={SVG_W - PAD_X}
            y2={g.y}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth="1"
          />
        ))}

        {/* Gradient fill */}
        {areaPath && (
          <path d={areaPath} fill="url(#chart-fill-grad)" className="chart-gradient-fill" />
        )}

        {/* Line — increased prominence */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* Emphasized last node */}
        {lastPoint && !hover && (
          <g className="chart-last-node">
            <circle cx={lastX} cy={lastY} r="5" fill="var(--color-accent)" stroke="#0A0A0A" strokeWidth="2" />
          </g>
        )}

        {/* Crosshair on hover */}
        {hover && (
          <g className="chart-crosshair">
            <line x1={hover.x} y1={PAD_Y} x2={hover.x} y2={SVG_H} stroke="rgba(255,255,255,0.12)" strokeWidth="1" strokeDasharray="4 3" />
            <circle cx={hover.x} cy={hover.y} r="5" fill="var(--color-accent)" stroke="#0A0A0A" strokeWidth="2" />
          </g>
        )}

        {/* Shared private sales — anonymous community contributions */}
        {visibleSharedSales.map((dot) => (
          <circle
            key={`${dot.date}-${dot.price}-${dot.x.toFixed(2)}`}
            cx={dot.x}
            cy={dot.y}
            r="4.5"
            fill="#60A5FA"
            stroke="#0A0A0A"
            strokeWidth="1.5"
            style={{ cursor: "pointer" }}
            onMouseEnter={() => setHoverDot({ x: dot.x, y: dot.y, price: dot.price, date: dot.date })}
            onMouseLeave={() => setHoverDot(null)}
          />
        ))}
      </svg>

      {/* Y-axis labels */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between py-[5%]">
        <span className="text-[12px] font-tabular text-[#444] pl-1">{formatUsd(max)}</span>
        <span className="text-[12px] font-tabular text-[#444] pl-1">{formatUsd(min)}</span>
      </div>

      {/* Hover tooltip — market line */}
      {hover && !hoverDot && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-white/[0.08] bg-[#151515] px-2.5 py-1.5 text-[14px] shadow-lg"
          style={{
            left: `${(hover.x / SVG_W) * 100}%`,
            transform: "translateX(-50%)",
          }}
        >
          <span className="font-semibold tabular-nums text-[#F0F0F0]">{formatUsd(hover.price)}</span>
          <span className="ml-2 text-[#6B6B6B]">{formatChartDate(hover.ts)}</span>
        </div>
      )}

      {/* Hover tooltip — community sale dot */}
      {hoverDot && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-[#1E3A5F] bg-[#0F1B2E] px-2.5 py-1.5 text-[13px] shadow-lg"
          style={{
            left: `${(hoverDot.x / SVG_W) * 100}%`,
            transform: "translateX(-50%)",
          }}
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#60A5FA]">Community</span>
          <span className="ml-2 font-semibold tabular-nums text-[#E5E7EB]">{formatUsd(hoverDot.price)}</span>
          <span className="ml-2 text-[#7A8AA0]">{formatChartDate(hoverDot.date)}</span>
        </div>
      )}

      {/* Legend — only shown when there's at least one community dot */}
      {visibleSharedSales.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-[#6B7280]">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded bg-[var(--color-accent)]" aria-hidden="true" />
            Market price
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[#60A5FA]" aria-hidden="true" />
            Community sale ({visibleSharedSales.length})
          </span>
        </div>
      )}
    </div>
  );
}
