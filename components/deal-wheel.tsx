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

// ── Drum Picker Constants ──
const ITEM_W = 56;
const HALF_VISIBLE = 7;

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
  const accent = toneColor(verdict.tone);
  const insight = getDealWheelInsight(price, balancePrice);

  // Drum items — fractional index for smooth scrolling
  const totalSteps = Math.round((max - min) / step);
  const rawIndex = (rawPrice - min) / step;
  const centerIndex = Math.min(totalSteps, Math.max(0, Math.round(rawIndex)));

  const drumItems: { idx: number; itemPrice: number; dist: number }[] = [];
  for (let i = -HALF_VISIBLE; i <= HALF_VISIBLE; i++) {
    const idx = centerIndex + i;
    if (idx < 0 || idx > totalSteps) continue;
    const itemPrice = normalizeDealWheelPrice(min + idx * step, balancePrice);
    const dist = idx - rawIndex;
    drumItems.push({ idx, itemPrice, dist });
  }

  // Selection window color follows tone
  const selBorder = verdict.tone === "positive"
    ? "rgba(0, 220, 90, 0.3)"
    : verdict.tone === "negative"
      ? "rgba(255, 59, 48, 0.3)"
      : "rgba(255, 255, 255, 0.1)";
  const selBg = verdict.tone === "positive"
    ? "rgba(0, 220, 90, 0.04)"
    : verdict.tone === "negative"
      ? "rgba(255, 59, 48, 0.04)"
      : "rgba(255, 255, 255, 0.02)";

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

  // ── Drag handlers ──
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
    const pricePerPx = step / ITEM_W;
    const newRaw = dragRef.current.startRaw - dx * pricePerPx;
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
        <div className="space-y-5">
          {/* Market Balance Price */}
          <div className="text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">Market Balance</p>
            <p className="mt-1 text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#F0F0F0] sm:text-[44px]">
              {formatUsd(balancePrice)}
            </p>
          </div>

          {/* Horizontal Drum Picker */}
          <div
            className="relative overflow-hidden rounded-2xl border border-[#1E1E1E] bg-[#0D0D0D]"
            style={{ height: 88 }}
          >
            {/* Selection window */}
            <div
              className="pointer-events-none absolute left-1/2 top-2 bottom-2 z-10 -translate-x-1/2 rounded-lg"
              style={{
                width: ITEM_W + 8,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: selBorder,
                background: selBg,
                transition: "border-color 200ms ease, background 200ms ease",
              }}
            />

            {/* Left gradient mask */}
            <div
              className="pointer-events-none absolute bottom-0 left-0 top-0 z-20"
              style={{ width: 64, background: "linear-gradient(to right, #0D0D0D, transparent)" }}
            />
            {/* Right gradient mask */}
            <div
              className="pointer-events-none absolute bottom-0 right-0 top-0 z-20"
              style={{ width: 64, background: "linear-gradient(to left, #0D0D0D, transparent)" }}
            />

            {/* Draggable items area */}
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
                const fontSize = absD < 0.6 ? 22 : absD < 1.6 ? 16 : absD < 2.6 ? 14 : 12;
                const opacity = Math.max(0.12, 1 - absD * 0.22);
                const fontWeight = absD < 0.6 ? 700 : absD < 1.6 ? 600 : 400;
                const color = isCenter
                  ? verdict.tone !== "neutral" ? accent : "#F0F0F0"
                  : "#888";

                return (
                  <div
                    key={item.idx}
                    className={`absolute left-1/2 top-1/2 flex items-center justify-center select-none ${isDragging ? "" : "deal-wheel-drum-snap"}`}
                    style={{
                      width: ITEM_W,
                      transform: `translate(calc(-50% + ${x}px), -50%)`,
                      fontSize,
                      fontWeight,
                      opacity,
                      color,
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

          {/* Hidden range input for keyboard a11y */}
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
