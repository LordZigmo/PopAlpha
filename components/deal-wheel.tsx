"use client";

import { useEffect, useId, useRef, useState } from "react";

import { GroupCard, GroupedSection, Pill } from "@/components/ios-grouped-ui";
import {
  evaluateDealWheelPrice,
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
    maximumFractionDigits: value < 10 ? 2 : 0,
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

function formatPercentOfMarket(value: number): string {
  if (!Number.isFinite(value)) return "\u2014";
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)}%`;
}

/** Smooth color interpolation based on price deviation percent */
function interpolateColor(differencePercent: number): string {
  // Clamp to +-45% range
  const t = Math.max(-1, Math.min(1, differencePercent / 45));
  const abs = Math.abs(t);
  // Ease the interpolation for smoother gradient
  const ease = abs * abs * (3 - 2 * abs); // smoothstep

  if (t < 0) {
    // Negative = buyer edge → green
    // Lerp from neutral to green
    const r = Math.round(240 - ease * 240);
    const g = Math.round(240 - ease * 20);
    const b = Math.round(240 - ease * 150);
    return `rgb(${r},${g},${b})`;
  }
  if (t > 0) {
    // Positive = dealer edge → red
    const r = Math.round(240 + ease * 15);
    const g = Math.round(240 - ease * 181);
    const b = Math.round(240 - ease * 192);
    return `rgb(${r},${g},${b})`;
  }
  return "#F0F0F0";
}

function toneColor(tone: "neutral" | "positive" | "negative"): string {
  if (tone === "positive") return "#00DC5A";
  if (tone === "negative") return "#FF3B30";
  return "#F0F0F0";
}

// ── Drum Picker ──
const ITEM_W = 72;
const HALF_VISIBLE = 4;

export default function DealWheel({ variants, selectedPrintingId }: DealWheelProps) {
  const activeVariant =
    variants.find((v) => v.printingId === selectedPrintingId)
    ?? variants[0]
    ?? null;
  const balancePrice = activeVariant?.marketBalancePrice ?? null;
  const validBalance = balancePrice !== null && Number.isFinite(balancePrice) && balancePrice > 0;
  const a11yInputId = useId();
  const [rawPrice, setRawPrice] = useState<number | null>(validBalance ? balancePrice : null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ active: false, startX: 0, startRaw: 0 });
  const snapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insightRef = useRef<HTMLParagraphElement>(null);
  const prevToneRef = useRef<"neutral" | "positive" | "negative">("neutral");

  useEffect(() => {
    if (validBalance) {
      setRawPrice(normalizeDealWheelPrice(balancePrice, balancePrice));
    } else {
      setRawPrice(null);
    }
  }, [activeVariant?.printingId, balancePrice, validBalance]);

  useEffect(() => {
    return () => {
      if (snapTimeoutRef.current) clearTimeout(snapTimeoutRef.current);
    };
  }, []);

  if (!activeVariant || !validBalance || rawPrice === null) return null;

  const step = getDealWheelStep(balancePrice);
  const { min, max } = getDealWheelBounds(balancePrice);
  const price = normalizeDealWheelPrice(rawPrice, balancePrice);
  const verdict = evaluateDealWheelPrice(price, balancePrice);
  const accent = interpolateColor(verdict.differencePercent);
  const toneAccent = toneColor(verdict.tone);
  const insight = getDealWheelInsight(price, balancePrice);
  const percentOfMarket = (price / balancePrice) * 100;

  const totalSteps = Math.round((max - min) / step);
  const rawIndex = (rawPrice - min) / step;
  const centerIndex = Math.min(totalSteps, Math.max(0, Math.round(rawIndex)));

  const drumItems: { idx: number; itemPrice: number; dist: number }[] = [];
  for (let i = -HALF_VISIBLE; i <= HALF_VISIBLE; i++) {
    const idx = centerIndex + i;
    if (idx < 0 || idx > totalSteps) continue;
    const itemPrice = normalizeDealWheelPrice(min + idx * step, balancePrice);
    drumItems.push({ idx, itemPrice, dist: idx - rawIndex });
  }

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
    ? "Balanced"
    : `${verdict.strength} ${verdict.label}`;

  // ── Drag ──
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { active: true, startX: e.clientX, startRaw: rawPrice };
    setIsDragging(true);
    if (snapTimeoutRef.current) clearTimeout(snapTimeoutRef.current);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const newRaw = dragRef.current.startRaw - dx * (step / ITEM_W);
    setRawPrice(Math.max(min, Math.min(max, newRaw)));
  };

  const handlePointerUp = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setIsDragging(false);
    const snapped = normalizeDealWheelPrice(rawPrice, balancePrice);
    const final = isNearCenter(snapped, balancePrice)
      ? normalizeDealWheelPrice(balancePrice, balancePrice)
      : snapped;
    if (snapTimeoutRef.current) clearTimeout(snapTimeoutRef.current);
    snapTimeoutRef.current = setTimeout(() => setRawPrice(final), 50);
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
        <div className="space-y-4">
          {/* Market Balance — compact single line */}
          <p className="text-center text-[13px] text-[#6B6B6B]">
            Market Balance{" "}
            <span className="font-semibold tabular-nums text-[#999]">{formatUsd(balancePrice)}</span>
          </p>

          {/* Drum Picker */}
          <div
            className="relative overflow-hidden rounded-2xl bg-[#0D0D0D]"
            style={{ height: 72 }}
          >
            {/* Center tick indicator */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center">
              <div className="h-5 w-px rounded-full bg-white/[0.16]" />
            </div>

            {/* Gradient masks */}
            <div
              className="pointer-events-none absolute bottom-0 left-0 top-0 z-20"
              style={{ width: 80, background: "linear-gradient(to right, #0D0D0D, transparent)" }}
            />
            <div
              className="pointer-events-none absolute bottom-0 right-0 top-0 z-20"
              style={{ width: 80, background: "linear-gradient(to left, #0D0D0D, transparent)" }}
            />

            {/* Drag surface + items */}
            <div
              className="absolute inset-0 z-30 cursor-grab active:cursor-grabbing"
              style={{ touchAction: "none" }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {drumItems.map((item) => {
                const absD = Math.abs(item.dist);
                const x = item.dist * ITEM_W;
                const isCenter = absD < 0.5;
                const opacity = absD < 0.5 ? 1 : absD < 1.5 ? 0.3 : absD < 2.5 ? 0.12 : 0.05;

                return (
                  <div
                    key={item.idx}
                    className={`absolute left-1/2 top-1/2 flex items-center justify-center select-none ${isDragging ? "" : "deal-wheel-drum-snap"}`}
                    style={{
                      width: ITEM_W,
                      transform: `translate(calc(-50% + ${x}px), -50%)`,
                      fontSize: 18,
                      fontWeight: 600,
                      opacity,
                      color: isCenter ? accent : "#F0F0F0",
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatUsd(item.itemPrice)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Hidden range for keyboard a11y */}
          <input
            id={a11yInputId}
            type="range"
            min={min}
            max={max}
            step={step}
            value={price}
            onChange={(e) => setRawPrice(Number(e.currentTarget.value))}
            className="sr-only"
            aria-label="Adjust price"
          />

          {/* Selected Price + Verdict — tight grouping */}
          <div className="text-center">
            <p
              className="text-[34px] font-bold leading-none tracking-[-0.03em] tabular-nums sm:text-[38px]"
              style={{ color: accent, transition: "color 150ms cubic-bezier(0.25,0.8,0.25,1)" }}
            >
              {formatUsd(price)}
            </p>
            <div className="mt-2 inline-flex items-center gap-2">
              <Pill label={pillLabel} tone={verdict.tone} />
              <span className="text-[13px] tabular-nums text-[#6B6B6B]">
                {formatSignedUsd(verdict.difference)} • {formatPercentOfMarket(percentOfMarket)} of market
              </span>
            </div>
          </div>

          {/* Insight */}
          <p
            ref={insightRef}
            className="deal-wheel-insight text-center text-[15px] leading-relaxed text-[#6B6B6B]"
          >
            {insight}
          </p>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-white/[0.05] bg-[#151515] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">Difference</p>
              <p className="mt-1 text-[22px] font-bold tabular-nums tracking-[-0.02em]" style={{ color: toneAccent }}>
                {formatSignedUsd(verdict.difference)}
              </p>
            </div>
            <div className="rounded-2xl border border-white/[0.05] bg-[#151515] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">Of Market</p>
              <p className="mt-1 text-[22px] font-bold tabular-nums tracking-[-0.02em]" style={{ color: toneAccent }}>
                {formatPercentOfMarket(percentOfMarket)}
              </p>
            </div>
          </div>
        </div>
      </GroupCard>
    </GroupedSection>
  );
}
