import type { Metadata } from "next";
import { getCanonicalRawFreshnessMonitor } from "@/lib/data/freshness";

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
  const monitor = await getCanonicalRawFreshnessMonitor(24);

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
      </div>
    </main>
  );
}

