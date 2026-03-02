"use client";

import { useEffect, useId, useRef, useState } from "react";

import { GroupCard, GroupedSection, Pill } from "@/components/ios-grouped-ui";
import {
  evaluateDealWheelPrice,
  getCenterProgress,
  getDealWheelBounds,
  getDealWheelInsight,
  getDealWheelStep,
  isNearCenter,
  normalizeDealWheelPrice,
} from "@/lib/cards/deal-wheel";

// TODO: Future "Advanced Mode" — Price Distribution Overlay
// Show where the selected price sits on a histogram of recent 30-day sales
// from price_history_points. Display percentile rank (e.g., "Cheaper than 72%
// of recent sales"). Uses existing getChartSeries() data. Monetizable as a
// "Pro" feature gated behind subscription.

type DealWheelVariant = {
  printingId: string;
  label: string;
  marketBalancePrice: number | null;
};

type DealWheelProps = {
  variants: DealWheelVariant[];
  selectedPrintingId: string | null;
};

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "\u2014";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatCompactUsd(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  if (value >= 100) return `$${Math.round(value)}`;
  return formatUsd(value);
}

function formatSignedUsd(value: number): string {
  const abs = Math.abs(value);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatUsd(abs)}`;
}

function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return "\u2014";
  const digits = Math.abs(value) >= 10 ? 0 : 1;
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toFixed(digits)}%`;
}

function toneColor(tone: "neutral" | "positive" | "negative"): string {
  if (tone === "positive") return "#00DC5A";
  if (tone === "negative") return "#FF3B30";
  return "#F0F0F0";
}

// ── Analog Gauge Geometry ──
const ARC_CX = 160;
const ARC_CY = 142;
const ARC_R = 105;
const ARC_START_DEG = 135; // lower-left (7:30 on clock)
const ARC_SWEEP_DEG = 270; // clockwise through top to lower-right (4:30)
const ARC_END_DEG = ARC_START_DEG + ARC_SWEEP_DEG;
const NEEDLE_LEN = 88;

function polarToXY(angleDeg: number, r: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: ARC_CX + r * Math.cos(rad), y: ARC_CY + r * Math.sin(rad) };
}

function describeArc(startDeg: number, endDeg: number, r: number): string {
  if (endDeg - startDeg < 0.1) return "";
  const start = polarToXY(startDeg, r);
  const end = polarToXY(endDeg, r);
  const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function priceToAngle(price: number, min: number, max: number): number {
  const t = max > min ? Math.max(0, Math.min(1, (price - min) / (max - min))) : 0.5;
  return ARC_START_DEG + t * ARC_SWEEP_DEG;
}

export default function DealWheel({ variants, selectedPrintingId }: DealWheelProps) {
  const activeVariant =
    variants.find((v) => v.printingId === selectedPrintingId)
    ?? variants[0]
    ?? null;
  const balancePrice = activeVariant?.marketBalancePrice ?? null;
  const validBalance = balancePrice !== null && Number.isFinite(balancePrice) && balancePrice > 0;
  const sliderId = useId();
  const rawSvgId = useId();
  const safeId = rawSvgId.replace(/:/g, "_");
  const [selectedPrice, setSelectedPrice] = useState<number | null>(validBalance ? balancePrice : null);
  const snapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insightRef = useRef<HTMLParagraphElement>(null);
  const prevToneRef = useRef<"neutral" | "positive" | "negative">("neutral");

  useEffect(() => {
    setSelectedPrice(validBalance ? normalizeDealWheelPrice(balancePrice, balancePrice) : null);
  }, [activeVariant?.printingId, balancePrice, validBalance]);

  useEffect(() => {
    return () => {
      if (snapTimeoutRef.current) clearTimeout(snapTimeoutRef.current);
    };
  }, []);

  if (!activeVariant || !validBalance || selectedPrice === null) return null;

  const step = getDealWheelStep(balancePrice);
  const { min, max } = getDealWheelBounds(balancePrice);
  const price = normalizeDealWheelPrice(selectedPrice, balancePrice);
  const verdict = evaluateDealWheelPrice(price, balancePrice);
  const accent = toneColor(verdict.tone);
  const centerProgress = getCenterProgress(price, balancePrice);
  const insight = getDealWheelInsight(price, balancePrice);

  // Gauge needle angle
  const needleAngle = priceToAngle(price, min, max);
  const balanceAngle = priceToAngle(balancePrice, min, max);

  // Neutral zone arc edges
  const neutralSpan = balancePrice * 0.03;
  const neutralStartAngle = priceToAngle(Math.max(min, balancePrice - neutralSpan), min, max);
  const neutralEndAngle = priceToAngle(Math.min(max, balancePrice + neutralSpan), min, max);

  // Tick marks — every 15°, major every 45°
  const TICK_STEP = 15;
  const totalTicks = Math.floor(ARC_SWEEP_DEG / TICK_STEP) + 1;
  const ticks = Array.from({ length: totalTicks }, (_, i) => {
    const angle = ARC_START_DEG + i * TICK_STEP;
    const isMajor = i % 3 === 0;
    const inner = polarToXY(angle, isMajor ? ARC_R - 14 : ARC_R - 8);
    const outer = polarToXY(angle, ARC_R - 1);
    // Show price label on first, middle, and last major tick
    const majorIndex = i / 3;
    const totalMajor = Math.floor((totalTicks - 1) / 3);
    const showLabel = isMajor && (majorIndex === 0 || majorIndex === Math.floor(totalMajor / 2) || majorIndex === totalMajor);
    const t = i / (totalTicks - 1);
    const tickPrice = min + t * (max - min);
    const labelPos = polarToXY(angle, ARC_R - 24);
    return { angle, inner, outer, isMajor, showLabel, tickPrice, labelPos };
  });

  // Balance marker
  const balOuter = polarToXY(balanceAngle, ARC_R + 3);
  const balInner = polarToXY(balanceAngle, ARC_R - 16);

  // Glow intensity
  const glowStdDev = 2 + Math.abs(centerProgress) * 5;

  // Fade insight text on tone change
  const toneChanged = verdict.tone !== prevToneRef.current;
  if (toneChanged) {
    prevToneRef.current = verdict.tone;
    if (insightRef.current) {
      insightRef.current.style.opacity = "0";
      setTimeout(() => {
        if (insightRef.current) insightRef.current.style.opacity = "1";
      }, 30);
    }
  }

  const pillLabel = verdict.tone === "neutral"
    ? "Fair Deal"
    : `${verdict.strength} ${verdict.label}`;

  const handlePointerUp = () => {
    if (isNearCenter(price, balancePrice)) {
      if (snapTimeoutRef.current) clearTimeout(snapTimeoutRef.current);
      snapTimeoutRef.current = setTimeout(() => {
        setSelectedPrice(normalizeDealWheelPrice(balancePrice, balancePrice));
      }, 50);
    }
  };

  const sliderProgress = max > min ? ((balancePrice - min) / (max - min)) * 100 : 50;

  return (
    <GroupedSection>
      <GroupCard
        className="glass-target"
        header={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[22px] font-semibold text-[#F0F0F0]">Deal Wheel</p>
              <p className="mt-1 text-[14px] text-[#6B6B6B]">Pressure-test a price against current market balance.</p>
            </div>
            <Pill label={activeVariant.label} tone="neutral" size="small" />
          </div>
        }
      >
        <div className="space-y-5">
          {/* Market Balance Price */}
          <div className="text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">Market Balance</p>
            <p className="mt-1 text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#F0F0F0] sm:text-[44px]">
              {formatUsd(balancePrice)}
            </p>
          </div>

          {/* SVG Analog Gauge */}
          <div className="flex justify-center">
            <svg
              viewBox="0 0 320 235"
              className="w-full max-w-[320px]"
              role="img"
              aria-label={`Price gauge needle at ${formatUsd(price)}`}
            >
              <defs>
                <filter id={`${safeId}-glow`} x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation={glowStdDev} />
                </filter>
                <radialGradient id={`${safeId}-face`} cx="50%" cy="45%" r="55%">
                  <stop offset="0%" stopColor="#1A1A1A" />
                  <stop offset="100%" stopColor="#0A0A0A" />
                </radialGradient>
              </defs>

              {/* Dial face */}
              <circle cx={ARC_CX} cy={ARC_CY} r={ARC_R + 12} fill={`url(#${safeId}-face)`} />
              <circle cx={ARC_CX} cy={ARC_CY} r={ARC_R + 12} fill="none" stroke="#333" strokeWidth={1.5} />

              {/* Track arc (base ring) */}
              <path
                d={describeArc(ARC_START_DEG, ARC_END_DEG, ARC_R)}
                fill="none"
                stroke="#252525"
                strokeWidth={16}
                strokeLinecap="round"
              />

              {/* Green zone — below balance (buyer advantage) */}
              {neutralStartAngle > ARC_START_DEG + 0.5 && (
                <path
                  d={describeArc(ARC_START_DEG, neutralStartAngle, ARC_R)}
                  fill="none"
                  stroke="#00DC5A"
                  strokeWidth={16}
                  opacity={0.15}
                  strokeLinecap="round"
                />
              )}

              {/* Red zone — above balance (dealer advantage) */}
              {ARC_END_DEG > neutralEndAngle + 0.5 && (
                <path
                  d={describeArc(neutralEndAngle, ARC_END_DEG, ARC_R)}
                  fill="none"
                  stroke="#FF3B30"
                  strokeWidth={16}
                  opacity={0.15}
                  strokeLinecap="round"
                />
              )}

              {/* Tick marks */}
              {ticks.map((tick, i) => (
                <g key={i}>
                  <line
                    x1={tick.inner.x}
                    y1={tick.inner.y}
                    x2={tick.outer.x}
                    y2={tick.outer.y}
                    stroke={tick.isMajor ? "#777" : "#444"}
                    strokeWidth={tick.isMajor ? 2 : 1}
                    strokeLinecap="round"
                  />
                  {tick.showLabel && (
                    <text
                      x={tick.labelPos.x}
                      y={tick.labelPos.y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#666"
                      fontSize="9"
                      fontWeight="600"
                      fontFamily="system-ui, sans-serif"
                    >
                      {formatCompactUsd(tick.tickPrice)}
                    </text>
                  )}
                </g>
              ))}

              {/* Balance marker — bright white tick */}
              <line
                x1={balOuter.x}
                y1={balOuter.y}
                x2={balInner.x}
                y2={balInner.y}
                stroke="#F0F0F0"
                strokeWidth={2.5}
                strokeLinecap="round"
              />

              {/* Needle group — rotates with spring overshoot */}
              <g
                className="deal-wheel-needle"
                style={{
                  transform: `rotate(${needleAngle}deg)`,
                  transformOrigin: `${ARC_CX}px ${ARC_CY}px`,
                }}
              >
                {/* Glow line (under needle) */}
                {verdict.tone !== "neutral" && (
                  <line
                    x1={ARC_CX}
                    y1={ARC_CY}
                    x2={ARC_CX + NEEDLE_LEN}
                    y2={ARC_CY}
                    stroke={accent}
                    strokeWidth={5}
                    strokeLinecap="round"
                    filter={`url(#${safeId}-glow)`}
                    opacity={0.5}
                  />
                )}
                {/* Needle body — tapered polygon pointing right (0°), rotated by group */}
                <polygon
                  points={`${ARC_CX + NEEDLE_LEN},${ARC_CY} ${ARC_CX + 12},${ARC_CY - 3.5} ${ARC_CX - 14},${ARC_CY - 4} ${ARC_CX - 18},${ARC_CY} ${ARC_CX - 14},${ARC_CY + 4} ${ARC_CX + 12},${ARC_CY + 3.5}`}
                  fill={accent}
                />
              </g>

              {/* Center hub */}
              <circle cx={ARC_CX} cy={ARC_CY} r={11} fill="#1A1A1A" stroke="#555" strokeWidth={2} />
              <circle cx={ARC_CX} cy={ARC_CY} r={5} fill="#777" />

              {/* Min / Max labels at arc endpoints */}
              <text
                x={polarToXY(ARC_START_DEG, ARC_R + 22).x}
                y={polarToXY(ARC_START_DEG, ARC_R + 22).y}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#555"
                fontSize="9"
                fontWeight="600"
                fontFamily="system-ui, sans-serif"
              >
                {formatCompactUsd(min)}
              </text>
              <text
                x={polarToXY(ARC_END_DEG, ARC_R + 22).x}
                y={polarToXY(ARC_END_DEG, ARC_R + 22).y}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#555"
                fontSize="9"
                fontWeight="600"
                fontFamily="system-ui, sans-serif"
              >
                {formatCompactUsd(max)}
              </text>
            </svg>
          </div>

          {/* Range Slider */}
          <div className="relative rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-2">
            <label htmlFor={sliderId} className="sr-only">
              Adjust price
            </label>
            <div className="relative" style={{ height: 36 }}>
              {/* Thin track bar */}
              <div
                className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2"
                style={{
                  height: 4,
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.06)",
                }}
              />
              {/* Center dot (market balance position) */}
              <div
                className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: `${sliderProgress}%`,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.2)",
                  zIndex: 1,
                }}
              />
              {/* Range input */}
              <input
                id={sliderId}
                type="range"
                min={min}
                max={max}
                step={step}
                value={price}
                onChange={(e) => setSelectedPrice(Number(e.currentTarget.value))}
                onPointerUp={handlePointerUp}
                onTouchEnd={handlePointerUp}
                className="deal-wheel-slider-v2 absolute inset-0"
                style={{ height: 36 }}
              />
            </div>
          </div>

          {/* Selected Price + Verdict */}
          <div className="text-center">
            <p
              className="text-[32px] font-bold leading-none tracking-[-0.03em] tabular-nums sm:text-[36px]"
              style={{ color: accent }}
            >
              {formatUsd(price)}
            </p>
            {verdict.tone !== "neutral" && (
              <p className="mt-1 text-[14px] tabular-nums text-[#6B6B6B]">
                {formatSignedUsd(verdict.difference)} ({formatSignedPercent(verdict.differencePercent)})
              </p>
            )}
            <div className="mt-2">
              <Pill label={pillLabel} tone={verdict.tone} />
            </div>
          </div>

          {/* Insight Line */}
          <p
            ref={insightRef}
            className="deal-wheel-insight text-center text-[15px] leading-relaxed text-[#6B6B6B]"
          >
            {insight}
          </p>

          {/* 2-Column Stats */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">Difference</p>
              <p className="mt-1 text-[22px] font-bold tabular-nums tracking-[-0.02em]" style={{ color: accent }}>
                {formatSignedUsd(verdict.difference)}
              </p>
            </div>
            <div className="rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">Variance</p>
              <p className="mt-1 text-[22px] font-bold tabular-nums tracking-[-0.02em]" style={{ color: accent }}>
                {formatSignedPercent(verdict.differencePercent)}
              </p>
            </div>
          </div>
        </div>
      </GroupCard>
    </GroupedSection>
  );
}
