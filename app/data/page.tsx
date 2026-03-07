import type { Metadata } from "next";
import {
  getCanonicalRawFreshnessMonitor,
  getPricingTransparencySnapshot,
  getPricingTransparencyTrend,
} from "@/lib/data/freshness";

export const metadata: Metadata = {
  title: "Data | PopAlpha",
  description: "Public data freshness monitor for canonical RAW card pricing.",
  alternates: {
    canonical: "/data",
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
  const [monitor, transparency, trend] = await Promise.all([
    getCanonicalRawFreshnessMonitor(24),
    getPricingTransparencySnapshot(),
    getPricingTransparencyTrend(7),
  ]);
  const statusTone: Record<"healthy" | "warning" | "critical", string> = {
    healthy: "text-[#4ADE80] border-[#14532D] bg-[#052E16]",
    warning: "text-[#FBBF24] border-[#78350F] bg-[#1C1917]",
    critical: "text-[#F87171] border-[#7F1D1D] bg-[#2A0F12]",
  };

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

          <div className="mt-4 rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
            <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">SLO Status</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {transparency.slo.map((row) => (
                <span
                  key={row.key}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-[12px] font-semibold ${statusTone[row.status]}`}
                >
                  {row.label}: {row.value} (target {row.target})
                </span>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-[#6B7280]">Threshold alerts auto-fire when an SLO leaves healthy range.</p>
          </div>

          <div className="mt-3 rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
            <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Active Alerts</p>
            <div className="mt-2 space-y-1 text-[14px] text-[#FCA5A5]">
              {transparency.alerts.length === 0 ? (
                <p className="text-[#86EFAC]">No active alerts.</p>
              ) : (
                transparency.alerts.map((alert) => <p key={alert}>• {alert}</p>)
              )}
            </div>
          </div>

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
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Excluded points (24h): <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.outlierDiagnostics24h.excludedPoints)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Impacted cards (24h): <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.outlierDiagnostics24h.impactedCards)}</span></p>
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

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Anomaly Alerts (24h)</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">Divergence &gt;80%: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.anomalies.providerDivergenceGt80PctCount)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Zero change spikes: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.anomalies.zeroChange24hCount)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Null 24h change: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.anomalies.nullChange24hCount)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">Set jumps &gt;40%: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.anomalies.setJumpGt40PctCount)}</span></p>
            </div>

            <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Backtest Accuracy</p>
              <p className="mt-2 text-[14px] text-[#9CA3AF]">Sample size: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparency.accuracyBacktest.sampleSize)}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">MAE: <span className="font-semibold text-[#E5E7EB]">{transparency.accuracyBacktest.mae ?? "n/a"}</span></p>
              <p className="mt-1 text-[14px] text-[#9CA3AF]">MAPE: <span className="font-semibold text-[#E5E7EB]">{transparency.accuracyBacktest.mape ?? "n/a"}%</span></p>
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
            Methodology: RAW market pricing is trust-weighted across JustTCG + Scrydex using freshness, volume, and agreement; robust MAD/IQR filtering excludes outliers before confidence bands are computed.
          </p>
        </section>

        <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <h2 className="text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">7-Day Trend</h2>
          <p className="mt-1 text-[13px] text-[#7A7A7A]">
            Snapshot-based history of key health metrics. Captured hourly.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-[13px]">
              <thead className="text-[#6B7280]">
                <tr>
                  <th className="px-2 py-2 font-medium">Captured</th>
                  <th className="px-2 py-2 font-medium">Freshness %</th>
                  <th className="px-2 py-2 font-medium">Coverage %</th>
                  <th className="px-2 py-2 font-medium">P90 Spread %</th>
                  <th className="px-2 py-2 font-medium">Queued</th>
                  <th className="px-2 py-2 font-medium">Retry</th>
                  <th className="px-2 py-2 font-medium">Failed</th>
                </tr>
              </thead>
              <tbody className="text-[#D1D5DB]">
                {trend.length === 0 ? (
                  <tr>
                    <td className="px-2 py-3 text-[#9CA3AF]" colSpan={7}>No trend history yet. First snapshots will appear after cron runs.</td>
                  </tr>
                ) : (
                  trend.slice(-24).map((row) => (
                    <tr key={row.capturedAt} className="border-t border-[#1F2937]">
                      <td className="px-2 py-2">{formatTimestamp(row.capturedAt)}</td>
                      <td className="px-2 py-2">{row.freshnessPct ?? "n/a"}</td>
                      <td className="px-2 py-2">{row.coverageBothPct ?? "n/a"}</td>
                      <td className="px-2 py-2">{row.p90SpreadPct ?? "n/a"}</td>
                      <td className="px-2 py-2">{row.queueDepth ?? "n/a"}</td>
                      <td className="px-2 py-2">{row.retryDepth ?? "n/a"}</td>
                      <td className="px-2 py-2">{row.failedDepth ?? "n/a"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
