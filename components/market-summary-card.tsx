import { GroupCard, GroupedSection, Pill, StatRow } from "@/components/ios-grouped-ui";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

type MarketSummaryCardProps = {
  canonicalSlug: string;
  printingId: string | null;
  variantRef: string | null;
};

type MarketLatestRow = {
  price_usd: number | null;
  observed_at: string | null;
  updated_at: string | null;
};

type HistoryPointRow = {
  ts: string;
  price: number;
};

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${rounded}%`;
}

function formatDateLabel(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelativeTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatUpdatedLabel(value: string | null): string {
  if (!value) return "—";
  const relative = formatRelativeTime(value);
  if (!relative) return formatDateLabel(value);
  return `${relative} • ${formatDateLabel(value)}`;
}

function computeChange30d(points: HistoryPointRow[]): number | null {
  if (points.length < 2) return null;
  const first = points[0]?.price;
  const last = points[points.length - 1]?.price;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  return ((last - first) / first) * 100;
}

function computeLowHigh(points: HistoryPointRow[]): { low: number | null; high: number | null } {
  if (points.length === 0) return { low: null, high: null };
  const prices = points
    .map((point) => point.price)
    .filter((value) => Number.isFinite(value));
  if (prices.length === 0) return { low: null, high: null };
  return {
    low: Math.min(...prices),
    high: Math.max(...prices),
  };
}

function buildSparklinePath(points: HistoryPointRow[]): string | null {
  if (points.length < 2) return null;
  const values = points
    .map((point) => point.price)
    .filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;

  const width = 280;
  const height = 78;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);

  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

export default async function MarketSummaryCard({
  canonicalSlug,
  printingId,
  variantRef,
}: MarketSummaryCardProps) {
  const supabase = getServerSupabaseClient();

  const [marketLatestQuery, historyQuery] = printingId && variantRef
    ? await Promise.all([
        supabase
          .from("market_latest")
          .select("price_usd, observed_at, updated_at")
          .eq("canonical_slug", canonicalSlug)
          .eq("printing_id", printingId)
          .eq("source", "JUSTTCG")
          .eq("grade", "RAW")
          .eq("price_type", "MARKET")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle<MarketLatestRow>(),
        supabase
          .from("price_history_points")
          .select("ts, price")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("source_window", "30d")
          .eq("variant_ref", variantRef)
          .order("ts", { ascending: false })
          .limit(200),
      ])
    : [
        { data: null },
        { data: [] as HistoryPointRow[] },
      ];

  const marketLatest = marketLatestQuery.data ?? null;
  const chartSeries = [...(((historyQuery.data ?? []) as HistoryPointRow[]))].reverse();
  const change30d = computeChange30d(chartSeries);
  const { low, high } = computeLowHigh(chartSeries);
  const sparklinePath = buildSparklinePath(chartSeries);
  const asOfTs = marketLatest?.observed_at ?? marketLatest?.updated_at ?? null;
  const sampleCount = chartSeries.length;

  return (
    <GroupedSection>
      <GroupCard
        header={
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px] font-semibold text-[#f5f7fb]">Market Summary</p>
            <Pill label="RAW cache" tone="neutral" size="small" />
          </div>
        }
      >
        {!marketLatest ? (
          <div className="rounded-2xl border border-white/[0.06] bg-[#11151d] px-4 py-5 text-[14px] text-[#98a0ae]">
            No market data yet.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(220px,0.8fr)]">
            <div className="rounded-2xl border border-white/[0.06] bg-[#11151d] p-4 sm:p-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#8c94a3]">Current Price</p>
              <div className="mt-2 text-[30px] font-semibold tracking-[-0.03em] text-[#f5f7fb]">
                {formatUsd(marketLatest.price_usd)}
              </div>
              <div className="mt-4 divide-y divide-white/[0.06] rounded-2xl border border-white/[0.06] bg-[#171b23] px-4">
                <StatRow label="Updated" value={formatUpdatedLabel(asOfTs)} />
                <StatRow label="Samples (30D)" value={sampleCount > 0 ? String(sampleCount) : "—"} />
              </div>

              <div className="mt-4 divide-y divide-white/[0.06] rounded-2xl border border-white/[0.06] bg-[#171b23] px-4">
                <StatRow label="30D Change" value={formatPercent(change30d)} />
                <StatRow label="30D Low" value={formatUsd(low)} />
                <StatRow label="30D High" value={formatUsd(high)} />
              </div>
            </div>

            <div className="rounded-2xl border border-white/[0.06] bg-[#11151d] p-4 sm:p-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#8c94a3]">30D Trend</p>
              {sparklinePath ? (
                <svg
                  viewBox="0 0 280 78"
                  className="mt-4 h-24 w-full"
                  role="img"
                  aria-label="30 day price sparkline"
                  preserveAspectRatio="none"
                >
                  <path
                    d={sparklinePath}
                    fill="none"
                    stroke="#8fb6ff"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <div className="mt-4 flex h-24 items-center justify-center rounded-2xl border border-dashed border-white/[0.08] text-[14px] text-[#98a0ae]">
                  No market data yet.
                </div>
              )}
            </div>
          </div>
        )}
      </GroupCard>
    </GroupedSection>
  );
}
