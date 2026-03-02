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

export default function DealWheel({ variants, selectedPrintingId }: DealWheelProps) {
  const activeVariant =
    variants.find((variant) => variant.printingId === selectedPrintingId)
    ?? variants[0]
    ?? null;
  const balancePrice = activeVariant?.marketBalancePrice ?? null;
  const validBalance = balancePrice !== null && Number.isFinite(balancePrice) && balancePrice > 0;
  const sliderId = useId();
  const [selectedPrice, setSelectedPrice] = useState<number | null>(validBalance ? balancePrice : null);
  const snapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insightRef = useRef<HTMLParagraphElement>(null);
  const prevToneRef = useRef<"neutral" | "positive" | "negative">("neutral");

  useEffect(() => {
    setSelectedPrice(validBalance ? normalizeDealWheelPrice(balancePrice, balancePrice) : null);
  }, [activeVariant?.printingId, balancePrice, validBalance]);

  // Cleanup snap timeout on unmount
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
  const progress = max > min ? ((price - min) / (max - min)) * 100 : 50;
  const centerProgress = getCenterProgress(price, balancePrice);
  const insight = getDealWheelInsight(price, balancePrice);

  // Fill geometry: how far from center (0-50%)
  const fillPercent = Math.abs(centerProgress) * 50;
  // Intensity: 0.4 at center, scales to 1.0 at edges
  const intensity = 0.4 + Math.abs(centerProgress) * 0.6;

  // Neutral zone: ±3% maps to a visual band on the track
  const neutralSpan = balancePrice * 0.03;
  const neutralLeftPct = max > min ? Math.max(0, ((balancePrice - neutralSpan - min) / (max - min)) * 100) : 47;
  const neutralRightPct = max > min ? Math.min(100, ((balancePrice + neutralSpan - min) / (max - min)) * 100) : 53;

  // Fade insight text when tone boundary changes
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

  // Combined verdict pill label
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
          {/* Market Balance Price — THE anchor */}
          <div className="text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">Market Balance</p>
            <p className="mt-1 text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#F0F0F0] sm:text-[44px]">
              {formatUsd(balancePrice)}
            </p>
          </div>

          {/* Center-Fill Slider */}
          <div className="relative rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-4">
            <label htmlFor={sliderId} className="sr-only">
              Adjust price
            </label>
            <div className="relative" style={{ height: 48 }}>
              {/* Visual track */}
              <div className="deal-wheel-track">
                {/* Neutral zone band */}
                <div
                  className="deal-wheel-neutral-zone"
                  style={{
                    left: `${neutralLeftPct}%`,
                    width: `${neutralRightPct - neutralLeftPct}%`,
                  }}
                />
                {/* Center tick */}
                <div className="deal-wheel-center-tick" />
                {/* Green fill (buyer advantage, left of center) */}
                {centerProgress < 0 && (
                  <div
                    className="deal-wheel-fill deal-wheel-fill-left"
                    style={{
                      width: `${fillPercent}%`,
                      opacity: intensity,
                    }}
                  />
                )}
                {/* Red fill (dealer advantage, right of center) */}
                {centerProgress > 0 && (
                  <div
                    className="deal-wheel-fill deal-wheel-fill-right"
                    style={{
                      width: `${fillPercent}%`,
                      opacity: intensity,
                    }}
                  />
                )}
              </div>
              {/* Thumb glow overlay */}
              {verdict.tone !== "neutral" && (
                <div
                  className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${progress}%`,
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: `radial-gradient(circle, ${accent}33 0%, transparent 70%)`,
                    zIndex: 1,
                  }}
                />
              )}
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
