"use client";

import { useEffect, useState } from "react";

import DealWheel from "@/components/deal-wheel";
import MarketSummaryCardClient from "@/components/market-summary-card-client";
import SignalGauge from "@/components/signal-gauge";

type HistoryPointRow = {
  ts: string;
  price: number;
};

type VariantMetricPayload = {
  printingId: string;
  label: string;
  currentPrice: number | null;
  marketBalancePrice: number | null;
  asOfTs: string | null;
  history7d: HistoryPointRow[];
  history30d: HistoryPointRow[];
  history90d: HistoryPointRow[];
  signalTrend: number | null;
  signalTrendLabel: string | null;
  signalBreakout: number | null;
  signalBreakoutLabel: string | null;
  signalValue: number | null;
  signalValueLabel: string | null;
  signalsHistoryPoints30d: number | null;
  signalsAsOfTs: string | null;
};

type CardMarketIntelClientProps = {
  variants: VariantMetricPayload[];
  selectedPrintingId: string | null;
  selectedWindow: "7d" | "30d" | "90d";
};

function signalConfidenceLabel(points30d: number | null): { label: string; tone: "positive" | "warning" | "negative" | "neutral" } {
  if (points30d === null || !Number.isFinite(points30d)) return { label: "--", tone: "neutral" };
  if (points30d >= 80) return { label: "High", tone: "positive" };
  if (points30d >= 30) return { label: "Medium", tone: "warning" };
  return { label: "Low", tone: "negative" };
}

function formatSignalsUpdated(value: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function CardMarketIntelClient({
  variants,
  selectedPrintingId,
  selectedWindow,
}: CardMarketIntelClientProps) {
  const [activePrintingId, setActivePrintingId] = useState<string | null>(selectedPrintingId);

  useEffect(() => {
    setActivePrintingId(selectedPrintingId);
  }, [selectedPrintingId]);

  const activeVariant =
    variants.find((variant) => variant.printingId === activePrintingId)
    ?? variants[0]
    ?? null;

  const hasSignals = !!(
    activeVariant
    && (
      activeVariant.signalTrend !== null
      || activeVariant.signalBreakout !== null
      || activeVariant.signalValue !== null
    )
  );

  const confidence = signalConfidenceLabel(activeVariant?.signalsHistoryPoints30d ?? null);

  return (
    <>
      {hasSignals ? (
        <div className="mt-6 grid grid-cols-3 gap-2 sm:gap-3">
          <SignalGauge
            label="Trend"
            score={activeVariant?.signalTrend ?? null}
            displayLabel={activeVariant?.signalTrendLabel ?? undefined}
          />
          <SignalGauge
            label="Breakout"
            score={activeVariant?.signalBreakout ?? null}
            displayLabel={activeVariant?.signalBreakoutLabel ?? undefined}
          />
          <SignalGauge
            label="Value"
            score={activeVariant?.signalValue ?? null}
            displayLabel={activeVariant?.signalValueLabel ?? undefined}
          />
        </div>
      ) : null}

      <MarketSummaryCardClient
        variants={variants.map((variant) => ({
          printingId: variant.printingId,
          label: variant.label,
          currentPrice: variant.currentPrice,
          asOfTs: variant.asOfTs,
          history7d: variant.history7d,
          history30d: variant.history30d,
          history90d: variant.history90d,
        }))}
        selectedPrintingId={activeVariant?.printingId ?? selectedPrintingId}
        selectedWindow={selectedWindow}
        onVariantChange={setActivePrintingId}
      />

      <DealWheel
        variants={variants.map((variant) => ({
          printingId: variant.printingId,
          label: variant.label,
          marketBalancePrice: variant.marketBalancePrice,
        }))}
        selectedPrintingId={activeVariant?.printingId ?? selectedPrintingId}
      />

      {(activeVariant?.signalsHistoryPoints30d != null || activeVariant?.signalsAsOfTs) ? (
        <div className="glass-target mt-4 flex flex-wrap gap-4 rounded-2xl border border-[#1E1E1E] bg-[#111111] px-4 py-3 sm:gap-6 sm:px-5 sm:py-3.5">
          {[
            {
              label: "Confidence",
              value: confidence.label,
              color: { positive: "#00DC5A", negative: "#FF3B30", warning: "#FFD60A", neutral: "#F0F0F0" }[confidence.tone],
            },
            {
              label: "Last Computed",
              value: formatSignalsUpdated(activeVariant?.signalsAsOfTs ?? null),
              color: "#F0F0F0",
            },
            {
              label: "Data Points",
              value: activeVariant?.signalsHistoryPoints30d != null ? String(activeVariant.signalsHistoryPoints30d) : "--",
              color: "#F0F0F0",
            },
          ].map((item) => (
            <div key={item.label} className="flex-1 min-w-[70px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B] sm:text-[13px]">{item.label}</p>
              <p className="mt-1 text-[17px] font-bold tabular-nums tracking-[-0.02em] sm:text-[20px]" style={{ color: item.color }}>{item.value}</p>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
