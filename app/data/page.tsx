import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, BarChart3, BookOpen, House, Layers3, Search } from "lucide-react";
import CanonicalCardShell from "@/components/layout/CanonicalCardShell";
import {
  getCanonicalRawFreshnessMonitor,
  getCanonicalRawRollingDailyFreshnessMonitors,
  getPricingTransparencySnapshot,
  getPricingTransparencyTrend,
  type CanonicalRawFreshnessMonitor,
} from "@/lib/data/freshness";

const title = "Data | PopAlpha";
const description = "Public data freshness monitor for canonical RAW card pricing.";
const canonicalPath = "/data";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: canonicalPath,
  },
  openGraph: {
    title,
    description,
    url: canonicalPath,
    siteName: "PopAlpha",
    type: "website",
    images: [
      { url: "/opengraph-image", alt: "PopAlpha" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/twitter-image"],
  },
};

export const dynamic = "force-dynamic";

const PRIMARY_FRESHNESS_WINDOW_HOURS = 24;
const EXTENDED_FRESHNESS_WINDOW_DAYS = [7, 30, 90] as const;

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

function getLoadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatFreshnessWindowDuration(windowHours: number): string {
  if (windowHours === 24) return "24 hours";
  if (windowHours % 24 === 0) {
    const dayCount = windowHours / 24;
    return `${dayCount} day${dayCount === 1 ? "" : "s"}`;
  }
  return `${windowHours} hour${windowHours === 1 ? "" : "s"}`;
}

function formatFreshnessWindowCardTitle(windowHours: number): string {
  if (windowHours % 24 === 0) {
    const dayCount = windowHours / 24;
    return `${dayCount}-Day Window`;
  }
  return `${windowHours}-Hour Window`;
}

function formatFreshnessWindowShortLabel(windowHours: number): string {
  if (windowHours === 24) return "24h";
  if (windowHours % 24 === 0) return `${windowHours / 24}d`;
  return `${windowHours}h`;
}

function FreshnessIndicatorCard({
  monitor,
  title,
  compact = false,
  mode = "recent_update",
}: {
  monitor: CanonicalRawFreshnessMonitor;
  title: string;
  compact?: boolean;
  mode?: "recent_update" | "daily_coverage";
}) {
  const windowDayCount = Math.max(1, Math.round(monitor.windowHours / 24));
  const detailCopy = mode === "daily_coverage"
    ? `${formatNumber(monitor.freshCanonicalRaw)} of ${formatNumber(monitor.totalCanonicalRaw)} canonical RAW cards have at least one recorded price on each trailing UTC day in the last ${windowDayCount} days.`
    : `${formatNumber(monitor.freshCanonicalRaw)} of ${formatNumber(monitor.totalCanonicalRaw)} canonical RAW cards have updated price data in the last ${formatFreshnessWindowDuration(monitor.windowHours)}.`;
  const cutoffLabel = mode === "daily_coverage" ? "Coverage window starts" : "Freshness window cutoff";

  return (
    <div className={`rounded-2xl border border-[#262626] bg-[#0D0D0D] ${compact ? "p-4" : "p-5"}`}>
      <p className="text-[12px] uppercase tracking-[0.14em] text-[#888]">
        {title}
      </p>
      <p className={`mt-2 font-semibold leading-none tracking-[-0.04em] text-[#4ADE80] ${compact ? "text-[36px] sm:text-[44px]" : "text-[44px] sm:text-[56px]"}`}>
        {monitor.freshPct.toFixed(2)}%
      </p>
      <p className="mt-2 text-[15px] text-[#9CA3AF]">
        {detailCopy}
      </p>

      <div className="mt-4 space-y-1 text-[13px] text-[#7A7A7A]">
        <p>As of: {formatTimestamp(monitor.asOf)}</p>
        <p>{cutoffLabel}: {formatTimestamp(monitor.cutoffIso)}</p>
      </div>
    </div>
  );
}

function UnavailablePanel({
  title = "Temporarily Unavailable",
  description,
  compact = false,
}: {
  title?: string;
  description: string;
  compact?: boolean;
}) {
  return (
    <div className={`rounded-2xl border border-[#78350F] bg-[#1C1917] ${compact ? "p-4" : "p-5"}`}>
      <p className="text-[12px] uppercase tracking-[0.14em] text-[#FBBF24]">
        {title}
      </p>
      <p className="mt-2 text-[15px] text-[#D1D5DB]">
        {description}
      </p>
    </div>
  );
}

type RailActionLink = {
  href: string;
  label: string;
  icon: typeof House;
};

type RailSectionLink = {
  href: string;
  label: string;
};

function RailAction({
  href,
  label,
  icon: Icon,
}: RailActionLink) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-[1.1rem] border border-transparent bg-transparent px-4 py-3 text-[#B0B0B0] transition hover:border-white/[0.05] hover:bg-white/[0.03] hover:text-white"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-[0.9rem] border border-[#1E1E1E] bg-[#0B0B0B] text-[#6B7280]">
        <Icon size={18} strokeWidth={2.1} />
      </span>
      <span className="text-[15px] font-semibold">{label}</span>
    </Link>
  );
}

function SectionJump({
  href,
  label,
}: RailSectionLink) {
  return (
    <a
      href={href}
      className="flex items-center justify-between rounded-[1rem] border border-[#1E1E1E] bg-[#0B0B0B] px-3 py-3 text-[13px] font-medium text-[#B0B0B0] transition hover:border-white/[0.06] hover:text-white"
    >
      <span>{label}</span>
      <ArrowRight size={14} />
    </a>
  );
}

function CompactFreshnessTile({
  label,
  monitor,
  mode = "recent_update",
}: {
  label: string;
  monitor: CanonicalRawFreshnessMonitor | null;
  mode?: "recent_update" | "daily_coverage";
}) {
  if (!monitor) {
    return (
      <div className="rounded-xl border border-[#262626] bg-[#0D0D0D] p-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-[#7A7A7A]">
          {label}
        </p>
        <p className="mt-2 text-[20px] font-semibold tracking-[-0.04em] text-[#FBBF24]">
          n/a
        </p>
        <p className="mt-2 text-[12px] leading-5 text-[#8B8B8B]">
          This window is unavailable right now.
        </p>
      </div>
    );
  }

  const detailCopy = mode === "daily_coverage"
    ? `${formatNumber(monitor.freshCanonicalRaw)} cards cover every UTC day`
    : `${formatNumber(monitor.freshCanonicalRaw)} cards updated in-window`;

  return (
    <div className="rounded-xl border border-[#262626] bg-[#0D0D0D] p-4">
      <p className="text-[11px] uppercase tracking-[0.14em] text-[#7A7A7A]">
        {label}
      </p>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-[-0.04em] text-[#4ADE80]">
        {monitor.freshPct.toFixed(2)}%
      </p>
      <p className="mt-2 text-[12px] leading-5 text-[#8B8B8B]">
        {detailCopy}
      </p>
    </div>
  );
}

export default async function DataPage() {
  const [primaryMonitorResult, extendedMonitorResult, transparencyResult, trendResult] = await Promise.allSettled([
    getCanonicalRawFreshnessMonitor(PRIMARY_FRESHNESS_WINDOW_HOURS),
    getCanonicalRawRollingDailyFreshnessMonitors([...EXTENDED_FRESHNESS_WINDOW_DAYS]),
    getPricingTransparencySnapshot(),
    getPricingTransparencyTrend(7),
  ]);

  const primaryMonitor = primaryMonitorResult.status === "fulfilled" ? primaryMonitorResult.value : null;
  const extendedMonitors = extendedMonitorResult.status === "fulfilled" ? extendedMonitorResult.value : [];
  const transparency = transparencyResult.status === "fulfilled" ? transparencyResult.value : null;
  const trend = trendResult.status === "fulfilled" ? trendResult.value : null;
  const extendedMonitorByWindowDays = new Map(
    extendedMonitors.map((monitor) => [Math.max(1, Math.round(monitor.windowHours / 24)), monitor] as const),
  );
  const windowSummaryCards = [
    { label: formatFreshnessWindowShortLabel(PRIMARY_FRESHNESS_WINDOW_HOURS), monitor: primaryMonitor, mode: "recent_update" as const },
    ...EXTENDED_FRESHNESS_WINDOW_DAYS.map((windowDays) => ({
      label: `${windowDays}d`,
      monitor: extendedMonitorByWindowDays.get(windowDays) ?? null,
      mode: "daily_coverage" as const,
    })),
  ];
  const latestTrendPoint = trend && trend.length > 0 ? trend[trend.length - 1] : null;
  const transparencyTotalRaw = transparency
    ? transparency.coverage.both + transparency.coverage.justtcgOnly + transparency.coverage.scrydexOnly + transparency.coverage.none
    : 0;
  const transparencyLiveCoverage = transparency?.coverage.market ?? 0;
  const transparencyLiveCoveragePct = transparency?.coverage.marketPct ?? 0;
  const transparencyUncoveredCount = transparency
    ? Math.max(0, transparencyTotalRaw - transparencyLiveCoverage)
    : 0;
  const quickActions: RailActionLink[] = [
    { href: "/", label: "Home", icon: House },
    { href: "/search", label: "Search", icon: Search },
    { href: "/sets", label: "Sets", icon: BookOpen },
    { href: "/portfolio", label: "Portfolio", icon: Layers3 },
  ];
  const pageLinks: RailSectionLink[] = [
    { href: "#freshness-24h", label: "24h Freshness" },
    { href: "#freshness-rolling", label: "7d / 30d / 90d" },
    { href: "#pricing-transparency", label: "Pricing Transparency" },
    { href: "#trend-history", label: "7-Day Trend" },
  ];

  if (primaryMonitorResult.status === "rejected") {
    console.error("[data/page] failed to load price freshness (24h)", getLoadErrorMessage(primaryMonitorResult.reason));
  }
  if (extendedMonitorResult.status === "rejected") {
    console.error("[data/page] failed to load rolling daily price freshness", getLoadErrorMessage(extendedMonitorResult.reason));
  }
  if (transparencyResult.status === "rejected") {
    console.error("[data/page] failed to load pricing transparency snapshot", getLoadErrorMessage(transparencyResult.reason));
  }
  if (trendResult.status === "rejected") {
    console.error("[data/page] failed to load pricing transparency trend", getLoadErrorMessage(trendResult.reason));
  }

  const statusTone: Record<"healthy" | "warning" | "critical", string> = {
    healthy: "text-[#4ADE80] border-[#14532D] bg-[#052E16]",
    warning: "text-[#FBBF24] border-[#78350F] bg-[#1C1917]",
    critical: "text-[#F87171] border-[#7F1D1D] bg-[#2A0F12]",
  };

  const contextRail = (
    <div className="px-5 py-6">
      <section className="rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Monitor Context</p>
        <div className="mt-4 flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-[1rem] border border-white/[0.06] bg-white/[0.03] text-[#8DF0B4]">
            <BarChart3 size={28} strokeWidth={2.1} />
          </div>
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-white">Canonical RAW Health</p>
            <p className="mt-1 text-[12px] uppercase tracking-[0.12em] text-[#6B7280]">
              Live pricing freshness and pipeline confidence
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B7280]">24h</p>
            <p className="mt-2 text-[18px] font-semibold text-white">{primaryMonitor ? `${primaryMonitor.freshPct.toFixed(2)}%` : "n/a"}</p>
          </div>
          <div className="rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B7280]">30d</p>
            <p className="mt-2 text-[18px] font-semibold text-white">
              {extendedMonitorByWindowDays.get(30) ? `${extendedMonitorByWindowDays.get(30)?.freshPct.toFixed(2)}%` : "n/a"}
            </p>
          </div>
          <div className="rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B7280]">Alerts</p>
            <p className="mt-2 text-[18px] font-semibold text-white">
              {transparency ? formatNumber(transparency.alerts.length) : "n/a"}
            </p>
          </div>
          <div className="rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B7280]">Trend</p>
            <p className="mt-2 text-[18px] font-semibold text-white">
              {latestTrendPoint?.freshnessPct != null ? `${latestTrendPoint.freshnessPct.toFixed(2)}%` : "n/a"}
            </p>
          </div>
        </div>
        {latestTrendPoint ? (
          <p className="mt-4 text-[12px] leading-5 text-[#8A8A8A]">
            Latest snapshot: {formatTimestamp(latestTrendPoint.capturedAt)}
          </p>
        ) : null}
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-4">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Quick Actions</p>
        <div className="mt-3 space-y-1.5">
          {quickActions.map((link) => (
            <RailAction key={`${link.label}-${link.href}`} {...link} />
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Window Snapshot</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {windowSummaryCards.map((entry) => (
            <CompactFreshnessTile
              key={entry.label}
              label={entry.label}
              monitor={entry.monitor}
              mode={entry.mode}
            />
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-4">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">On Page</p>
        <div className="mt-3 space-y-2">
          {pageLinks.map((link) => (
            <SectionJump key={link.href} {...link} />
          ))}
        </div>
      </section>
    </div>
  );

  return (
    <CanonicalCardShell backHref="/" rightRail={contextRail}>
      <div className="mx-auto max-w-5xl px-4 pb-[max(env(safe-area-inset-bottom),2.5rem)] pt-8 sm:px-6 sm:pb-[max(env(safe-area-inset-bottom),3.5rem)]">
        <div className="space-y-6">
          <section id="freshness-24h" className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
              Public Data Monitor
            </p>
            <h1 className="mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.05em] sm:text-[44px]">
              Price Freshness (24h)
            </h1>
            <p className="mt-3 max-w-2xl text-[14px] leading-6 text-[#8B8B8B]">
              Live public health view for canonical RAW pricing, live market freshness, coverage quality, and pipeline reliability.
            </p>

            {primaryMonitor ? (
              <div className="mt-6">
                <FreshnessIndicatorCard monitor={primaryMonitor} title="Coverage" />
              </div>
            ) : (
              <div className="mt-6">
                <UnavailablePanel description="Live price freshness could not be loaded right now. We will keep trying this request-time query on each refresh." />
              </div>
            )}
          </section>

          <section id="freshness-rolling" className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
            <h2 className="text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">Price Freshness (7d / 30d / 90d)</h2>
            <p className="mt-1 text-[13px] text-[#7A7A7A]">
              A card only counts as fresh when it has at least one recorded price on every trailing UTC day inside the window.
            </p>

            <div className="mt-6 grid gap-4 lg:grid-cols-3">
              {EXTENDED_FRESHNESS_WINDOW_DAYS.map((windowDays) => {
                const monitor = extendedMonitorByWindowDays.get(windowDays) ?? null;
                return monitor ? (
                  <FreshnessIndicatorCard
                    key={windowDays}
                    monitor={monitor}
                    title={formatFreshnessWindowCardTitle(monitor.windowHours)}
                    compact
                    mode="daily_coverage"
                  />
                ) : (
                  <UnavailablePanel
                    key={windowDays}
                    compact
                    title={`${windowDays}-Day Window`}
                    description="This rolling window could not be loaded right now."
                  />
                );
              })}
            </div>
          </section>

          <section id="pricing-transparency" className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
            <h2 className="text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">Pricing Transparency</h2>
            {transparency ? (
              <>
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
                    <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Snapshot Coverage (24h)</p>
                  <p className="mt-2 text-[14px] text-[#9CA3AF]">
                    Canonical cards with at least one snapshot:
                    {" "}
                    <span className="font-semibold text-[#E5E7EB]">
                      {transparency.snapshotCoverage24h.cardsWithSnapshotCount != null
                        ? `${formatNumber(transparency.snapshotCoverage24h.cardsWithSnapshotCount)} (${transparency.snapshotCoverage24h.cardsWithSnapshotPct ?? 0}%)`
                        : "n/a"}
                    </span>
                  </p>
                  <p className="mt-1 text-[12px] text-[#6B7280]">
                    Distinct canonical RAW cards with any provider snapshot in the last 24 hours.
                  </p>
                </div>

                <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
                  <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Live Market Freshness (24h)</p>
                  <p className="mt-2 text-[14px] text-[#9CA3AF]">Scrydex-backed snapshots: <span className="font-semibold text-[#E5E7EB]">{transparency.freshnessByProvider24h.scrydexPct ?? 0}%</span></p>
                  <p className="mt-1 text-[12px] text-[#6B7280]">Distinct canonical RAW cards with SCRYDEX or Pokemon TCG API snapshots in the last 24 hours.</p>
                </div>

                <div className="rounded-xl border border-[#222] bg-[#0D0D0D] p-4">
                  <p className="text-[12px] uppercase tracking-[0.12em] text-[#7A7A7A]">Live Market Coverage</p>
                  <p className="mt-2 text-[14px] text-[#9CA3AF]">Cards with a live market price: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparencyLiveCoverage)} ({transparencyLiveCoveragePct}%)</span></p>
                  <p className="mt-1 text-[14px] text-[#9CA3AF]">Cards without a live market price: <span className="font-semibold text-[#E5E7EB]">{formatNumber(transparencyUncoveredCount)}</span></p>
                  {transparency.coverage.justtcgOnly > 0 ? (
                    <p className="mt-1 text-[12px] text-[#6B7280]">
                      Legacy JustTCG-only rows are excluded from live coverage after the provider retirement.
                    </p>
                  ) : null}
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
                  <p className="mt-2 text-[14px] text-[#9CA3AF]">Scrydex-backed observations: <span className="font-semibold text-[#E5E7EB]">{transparency.ingestionVolume24h.scrydexObservations ?? "n/a"}</span></p>
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
                Methodology: RAW market pricing is now live-market-first through the active Scrydex-backed pipeline. Retired JustTCG-only rows are excluded from live coverage, while confidence still reflects freshness, sample size, and outlier filtering.
              </p>
            </>
          ) : (
            <div className="mt-4">
              <UnavailablePanel description="The pricing transparency snapshot could not be loaded right now. Price freshness will keep rendering independently." />
            </div>
          )}
          </section>

          <section id="trend-history" className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
            <h2 className="text-[22px] font-semibold tracking-[-0.03em] sm:text-[28px]">7-Day Trend</h2>
            <p className="mt-1 text-[13px] text-[#7A7A7A]">
              Snapshot-based history of key health metrics. Captured hourly.
            </p>
            {trend ? (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-[13px]">
                  <thead className="text-[#6B7280]">
                    <tr>
                      <th className="px-2 py-2 font-medium">Captured</th>
                      <th className="px-2 py-2 font-medium">Freshness %</th>
                      <th className="px-2 py-2 font-medium">P90 Spread %</th>
                      <th className="px-2 py-2 font-medium">Queued</th>
                      <th className="px-2 py-2 font-medium">Retry</th>
                      <th className="px-2 py-2 font-medium">Failed</th>
                    </tr>
                  </thead>
                  <tbody className="text-[#D1D5DB]">
                    {trend.length === 0 ? (
                      <tr>
                        <td className="px-2 py-3 text-[#9CA3AF]" colSpan={6}>No trend history yet. First snapshots will appear after cron runs.</td>
                      </tr>
                    ) : (
                      trend.slice(-24).map((row) => (
                        <tr key={row.capturedAt} className="border-t border-[#1F2937]">
                          <td className="px-2 py-2">{formatTimestamp(row.capturedAt)}</td>
                          <td className="px-2 py-2">{row.freshnessPct ?? "n/a"}</td>
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
            ) : (
              <div className="mt-4">
                <UnavailablePanel description="Trend history could not be loaded right now. The current price freshness reading will still render above when available." />
              </div>
            )}
          </section>
        </div>
      </div>
    </CanonicalCardShell>
  );
}
