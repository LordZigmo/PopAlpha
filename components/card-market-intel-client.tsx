"use client";

import { useEffect, useState } from "react";

import DealWheel from "@/components/deal-wheel";
import LiquidityModule from "@/components/liquidity-module";
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
  justtcgPrice: number | null;
  justtcgAsOfTs: string | null;
  scrydexPrice: number | null;
  scrydexAsOfTs: string | null;
  marketBalancePrice: number | null;
  asOfTs: string | null;
  trendSlope7d: number | null;
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
  liquidityScore: number | null;
  liquidityTier: string | null;
  liquidityTone: "warning" | "neutral" | "positive";
  liquidityPriceChanges30d: number | null;
  liquiditySnapshotCount30d: number | null;
  liquiditySpreadPercent: number | null;
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
        <div className="fade-slide-up mt-6 grid grid-cols-3 gap-2 sm:gap-3">
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
          justtcgPrice: variant.justtcgPrice,
          justtcgAsOfTs: variant.justtcgAsOfTs,
          scrydexPrice: variant.scrydexPrice,
          scrydexAsOfTs: variant.scrydexAsOfTs,
          asOfTs: variant.asOfTs,
          trendSlope7d: variant.trendSlope7d,
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

      <LiquidityModule
        score={activeVariant?.liquidityScore ?? null}
        tier={activeVariant?.liquidityTier ?? null}
        tone={activeVariant?.liquidityTone ?? "neutral"}
        priceChanges30d={activeVariant?.liquidityPriceChanges30d ?? null}
        snapshotCount30d={activeVariant?.liquiditySnapshotCount30d ?? null}
        spreadPercent={activeVariant?.liquiditySpreadPercent ?? null}
      />

      {(activeVariant?.signalsHistoryPoints30d != null || activeVariant?.signalsAsOfTs) ? (
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          {/* Confidence badge */}
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold"
            style={{
              color: { positive: "#00DC5A", negative: "#FF3B30", warning: "#FFD60A", neutral: "#999" }[confidence.tone],
              borderColor: { positive: "rgba(0,220,90,0.2)", negative: "rgba(255,59,48,0.2)", warning: "rgba(255,214,10,0.2)", neutral: "rgba(255,255,255,0.06)" }[confidence.tone],
              backgroundColor: { positive: "rgba(0,220,90,0.06)", negative: "rgba(255,59,48,0.06)", warning: "rgba(255,214,10,0.06)", neutral: "rgba(255,255,255,0.03)" }[confidence.tone],
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: { positive: "#00DC5A", negative: "#FF3B30", warning: "#FFD60A", neutral: "#555" }[confidence.tone],
              }}
            />
            {confidence.label} confidence
          </span>

          {/* Sample size */}
          {activeVariant?.signalsHistoryPoints30d != null && (
            <span className="text-[13px] tabular-nums text-[#555]">
              {activeVariant.signalsHistoryPoints30d} data points
            </span>
          )}

          {/* Last computed */}
          <span className="text-[13px] text-[#444]">
            {formatSignalsUpdated(activeVariant?.signalsAsOfTs ?? null)}
          </span>
        </div>
      ) : null}
    </>
  );
}
