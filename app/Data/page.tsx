import type { Metadata } from "next";
import { getCanonicalRawFreshnessMonitor, getPricingTransparencySnapshot } from "@/lib/data/freshness";

export const metadata: Metadata = {
  title: "Data | PopAlpha",
  description: "Public data freshness monitor for canonical RAW card pricing.",
  alternates: {
    canonical: "/Data",
  },
};

export const revalidate = 300;

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

export default async function DataPage() {
  const [monitor, transparency] = await Promise.all([
    getCanonicalRawFreshnessMonitor(24),
    getPricingTransparencySnapshot(),
  ]);

  return (
    <main className="min-h-screen bg-[#0A0A0A] px-4 py-12 text-[#F0F0F0] sm:px-6">
      <div className="mx-auto max-w-4xl">
        <section className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            Public Data Monitor
          </p>
          <h1 className="mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.05em] sm:text-[44px]">
            Canonical RAW Price Freshness (24h)
          </h1>

          <div className="mt-6 rounded-2xl border border-[#262626] bg-[#0D0D0D] p-5">
            <p className="text-[12px] uppercase tracking-[0.14em] text-[#888]">
              Coverage
            </p>
            <p className="mt-2 text-[44px] font-semibold leading-none tracking-[-0.04em] text-[#4ADE80] sm:text-[56px]">
              {monitor.freshPct.toFixed(2)}%
            </p>
            <p className="mt-2 text-[15px] text-[#9CA3AF]">
              {formatNumber(monitor.freshCanonicalRaw)} of {formatNumber(monitor.totalCanonicalRaw)} canonical RAW cards
              have updated price data in the last 24 hours.
            </p>
          </div>

          <div className="mt-4 space-y-1 text-[13px] text-[#7A7A7A]">
            <p>As of: {formatTimestamp(monitor.asOf)}</p>
            <p>Freshness window cutoff: {formatTimestamp(monitor.cutoffIso)}</p>
          </div>
        </section>

        <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <h2 className="text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">Pricing Transparency</h2>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Provider Freshness (24h)</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">JustTCG: <span className="font-semibold text-[#E5E7EB]">{transparency.freshnessByProvider24h.justtcgPct ?? 0}%</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Scrydex: <span className="font-semibold text-[#E5E7EB]">{transparency.freshnessByProvider24h.scrydexPct ?? 0}%</span></p>
            </div>

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Coverage</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">Both providers: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.coverage.both)} ({transparency.coverage.bothPct}%)</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">JustTCG only: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.coverage.justtcgOnly)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Scrydex only: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.coverage.scrydexOnly)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">No price: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.coverage.none)}</span></p>
            </div>

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Staleness Distribution</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">&lt;6h: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.stalenessBuckets.under6h)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">6-24h: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.stalenessBuckets.h6to24)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">1-3d: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.stalenessBuckets.d1to3)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">&gt;3d: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.stalenessBuckets.over3d)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Missing TS: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.stalenessBuckets.missingTs)}</span></p>
            </div>

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Price Agreement</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">Comparable cards: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.priceAgreement.comparableCards)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Median spread: <span className="font-semibold text-[#E5E7EB]">{transparency.priceAgreement.medianSpreadPct ?? 0}%</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">P90 spread: <span className="font-semibold text-[#E5E7EB]">{transparency.priceAgreement.p90SpreadPct ?? 0}%</span></p>
            </div>

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Outlier Guardrails</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">Ratio ≥ 3.5x: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.outlierGuardrails.ratioGte3p5Count)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Share of comparable: <span className="font-semibold text-[#E5E7EB]">{transparency.outlierGuardrails.ratioGte3p5Pct ?? 0}%</span></p>
            </div>

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Data Quality Flags</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">Sentinel 23456.78: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.dataQualityFlags.sentinel23456Count)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Priced but missing TS: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.dataQualityFlags.pricedButMissingTsCount)}</span></p>
            </div>

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Ingestion Volume (24h)</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">JustTCG observations: <span className="font-semibold text-[#E5E7EB]">{transparency.ingestionVolume24h.justtcgObservations ?? "n/a"}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Scrydex observations: <span className="font-semibold text-[#E5E7EB]">{transparency.ingestionVolume24h.scrydexObservations ?? "n/a"}</span></p>
            </div>

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Pipeline Health</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">Queued: <span className="font-semibold text-[#E5E7EB]">{transparency.pipelineHealth.queueDepth ?? "n/a"}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Retry: <span className="font-semibold text-[#E5E7EB]">{transparency.pipelineHealth.retryDepth ?? "n/a"}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Failed: <span className="font-semibold text-[#E5E7EB]">{transparency.pipelineHealth.failedDepth ?? "n/a"}</span></p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Top Stale Sets (&gt;24h)</p>
              <div className="mt-2 space-y-1 text-[14px] text-[#9CA3AF]">
                {transparency.setFreshness24h.stalest.map((row) => (
                  <p key={`stale-${row.setName}`}>{row.setName}: <span className="font-semibold text-[#E5E7EB]">{formatNumber(row.cards)}</span></p>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Top Fresh Sets (&lt;24h)</p>
              <div className="mt-2 space-y-1 text-[14px] text-[#9CA3AF]">
                {transparency.setFreshness24h.freshest.map((row) => (
                  <p key={`fresh-${row.setName}`}>{row.setName}: <span className="font-semibold text-[#E5E7EB]">{formatNumber(row.cards)}</span></p>
                ))}
              </div>
            </div>
          </div>

          <p className="mt-5 text-[12px] text-[#6B7280]">
            Methodology: RAW market pricing is blended from JustTCG + Scrydex when both are available, with outlier guardrails when provider divergence is extreme.
          </p>
        </section>
      </div>
    </main>
  );
}
