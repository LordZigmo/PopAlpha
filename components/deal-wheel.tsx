"use client";

import { useEffect, useId, useState } from "react";

import { GroupCard, GroupedSection, Pill } from "@/components/ios-grouped-ui";
import {
  evaluateDealWheelPrice,
  getDealWheelBounds,
  getDealWheelStep,
  normalizeDealWheelPrice,
} from "@/lib/cards/deal-wheel";

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
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
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
  if (!Number.isFinite(value)) return "—";
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

  useEffect(() => {
    setSelectedPrice(validBalance ? normalizeDealWheelPrice(balancePrice, balancePrice) : null);
  }, [activeVariant?.printingId, balancePrice, validBalance]);

  if (!activeVariant || !validBalance || selectedPrice === null) return null;

  const step = getDealWheelStep(balancePrice);
  const { min, max } = getDealWheelBounds(balancePrice);
  const price = normalizeDealWheelPrice(selectedPrice, balancePrice);
  const verdict = evaluateDealWheelPrice(price, balancePrice);
  const progress = max > min ? ((price - min) / (max - min)) * 100 : 50;
  const accent = toneColor(verdict.tone);
  const rangeBackground = `linear-gradient(90deg, ${accent} 0%, ${accent} ${progress}%, rgba(255,255,255,0.08) ${progress}%, rgba(255,255,255,0.08) 100%)`;

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
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B]">Selected Price</p>
              <p className="mt-1 text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#F0F0F0] sm:text-[44px]">
                {formatUsd(price)}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Pill label={verdict.label} tone={verdict.tone} />
              <Pill label={verdict.strength} tone={verdict.tone} />
            </div>
          </div>

          <div className="rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-4">
            <label htmlFor={sliderId} className="sr-only">
              Adjust price
            </label>
            <input
              id={sliderId}
              type="range"
              min={min}
              max={max}
              step={step}
              value={price}
              onChange={(event) => setSelectedPrice(Number(event.currentTarget.value))}
              className="deal-wheel-slider h-12 w-full cursor-pointer appearance-none bg-transparent"
              style={{ background: rangeBackground }}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">Market Balance</p>
              <p className="mt-1 text-[22px] font-bold tabular-nums tracking-[-0.02em] text-[#F0F0F0]">
                {formatUsd(balancePrice)}
              </p>
            </div>
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

          <p className="rounded-2xl border border-[#1E1E1E] bg-[#151515] px-4 py-3 text-[15px] leading-relaxed text-[#D0D0D0]">
            {verdict.explanation}
          </p>

          <style jsx>{`
            .deal-wheel-slider {
              --thumb-size: 30px;
            }

            .deal-wheel-slider::-webkit-slider-runnable-track {
              height: 14px;
              border-radius: 999px;
              background: transparent;
            }

            .deal-wheel-slider::-moz-range-track {
              height: 14px;
              border-radius: 999px;
              background: transparent;
            }

            .deal-wheel-slider::-webkit-slider-thumb {
              -webkit-appearance: none;
              appearance: none;
              width: var(--thumb-size);
              height: var(--thumb-size);
              margin-top: -8px;
              border: 1px solid rgba(255, 255, 255, 0.14);
              border-radius: 999px;
              background:
                radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.82) 38%, rgba(210, 210, 210, 0.9) 100%);
              box-shadow:
                0 10px 18px rgba(0, 0, 0, 0.4),
                inset 0 1px 1px rgba(255, 255, 255, 0.55);
            }

            .deal-wheel-slider::-moz-range-thumb {
              width: var(--thumb-size);
              height: var(--thumb-size);
              border: 1px solid rgba(255, 255, 255, 0.14);
              border-radius: 999px;
              background:
                radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.82) 38%, rgba(210, 210, 210, 0.9) 100%);
              box-shadow:
                0 10px 18px rgba(0, 0, 0, 0.4),
                inset 0 1px 1px rgba(255, 255, 255, 0.55);
            }
          `}</style>
        </div>
      </GroupCard>
    </GroupedSection>
  );
}
