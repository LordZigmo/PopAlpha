"use client";

import { useState } from "react";
import type { CardDetailResponse, CardDetailMetrics, GradeBucket, GradedProvider } from "@/lib/cards/detail-types";

type CardDetailInstrumentsProps = {
  detail: CardDetailResponse;
};

function pillClass(active: boolean, disabled = false): string {
  if (disabled) {
    return "rounded-full border px-3 py-1.5 text-xs font-semibold opacity-50";
  }
  return active
    ? "rounded-full border px-3 py-1.5 text-xs font-semibold bg-[#2b313d] text-[#f5f7fb]"
    : "rounded-full border px-3 py-1.5 text-xs font-semibold";
}

function formatMetric(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function metricCard(label: string, metrics: CardDetailMetrics | null) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#98a0ae]">{label}</p>
      <p className="mt-2 text-sm text-[#f5f7fb]">Trend: {formatMetric(metrics?.trend ?? null)}</p>
      <p className="mt-1 text-sm text-[#f5f7fb]">Breakout: {formatMetric(metrics?.breakout ?? null)}</p>
      <p className="mt-1 text-sm text-[#f5f7fb]">Value: {formatMetric(metrics?.valueZone ?? null)}</p>
      <p className="mt-1 text-xs text-[#8c94a3]">Points 30D: {metrics?.points30d ?? "—"}</p>
      <p className="mt-1 text-xs text-[#8c94a3]">Liquidity: {formatMetric(metrics?.liquidityScore ?? null)}</p>
      <p className="mt-2 text-[11px] text-[#8c94a3]">As of: {metrics?.asOf ?? "—"}</p>
    </div>
  );
}

export default function CardDetailInstruments({ detail }: CardDetailInstrumentsProps) {
  const [mode, setMode] = useState<"RAW" | "GRADED">(detail.defaults.mode);
  const [printingId, setPrintingId] = useState<string | null>(detail.defaults.printingId);
  const [provider, setProvider] = useState<GradedProvider | null>(detail.defaults.provider);
  const [gradeBucket, setGradeBucket] = useState<GradeBucket | null>(detail.defaults.gradeBucket);

  const selectedRaw =
    detail.raw.variants.find((variant) => variant.printingId === printingId)
    ?? detail.raw.variants[0]
    ?? null;

  const gradedRowsForPrinting = detail.graded.matrix.filter((row) => !printingId || row.printingId === printingId);
  const selectedGraded =
    detail.graded.matrix.find((row) => {
      return row.printingId === printingId && row.provider === provider && row.gradeBucket === gradeBucket;
    })
    ?? gradedRowsForPrinting[0]
    ?? null;

  return (
    <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={pillClass(mode === "RAW")} onClick={() => setMode("RAW")}>
          RAW
        </button>
        <button
          type="button"
          className={pillClass(mode === "GRADED", !detail.graded.matrix.length)}
          onClick={() => {
            if (!detail.graded.matrix.length) return;
            setMode("GRADED");
          }}
          disabled={!detail.graded.matrix.length}
        >
          GRADED
        </button>
      </div>

      {mode === "RAW" ? (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {detail.raw.variants.map((variant) => (
              <button
                key={variant.printingId}
                type="button"
                className={pillClass(printingId === variant.printingId, !variant.available)}
                onClick={() => setPrintingId(variant.printingId)}
              >
                {variant.pillLabel}
              </button>
            ))}
          </div>
          <div className="mt-4">
            {metricCard(selectedRaw?.pillLabel ?? "RAW", selectedRaw?.metrics ?? null)}
          </div>
        </>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {detail.raw.variants.map((variant) => (
              <button
                key={variant.printingId}
                type="button"
                className={pillClass(printingId === variant.printingId)}
                onClick={() => setPrintingId(variant.printingId)}
              >
                {variant.pillLabel}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {detail.graded.providers.map((item) => (
              <button
                key={item.provider}
                type="button"
                className={pillClass(provider === item.provider, !item.available)}
                onClick={() => setProvider(item.provider)}
              >
                {item.provider}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {detail.graded.grades.map((item) => (
              <button
                key={item.gradeBucket}
                type="button"
                className={pillClass(gradeBucket === item.gradeBucket, !item.available)}
                onClick={() => setGradeBucket(item.gradeBucket)}
              >
                {item.gradeBucket}
              </button>
            ))}
          </div>
          <div className="mt-4">
            {metricCard(
              `${selectedGraded?.provider ?? "GRADED"} ${selectedGraded?.gradeBucket ?? ""}`.trim(),
              selectedGraded?.metrics ?? null,
            )}
          </div>
        </>
      )}
    </section>
  );
}
