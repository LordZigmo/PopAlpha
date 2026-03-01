import { GroupCard, GroupedSection, Pill, StatRow } from "@/components/ios-grouped-ui";

type ChartPoint = {
  ts: string;
  price: number;
};

type MarketSummaryCardProps = {
  currentMarketPrice: number | null;
  change7dPct: number | null;
  change30dPct: number | null;
  change90dPct: number | null;
  volume30d: number | null;
  activeListings: number | null;
  chartSeries: ChartPoint[];
  high52w: number | null;
  low52w: number | null;
  volatility: number | null;
};

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  const rounded = Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${rounded}%`;
}

function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatVolatility(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(2)}`;
}

function buildSparklinePath(points: ChartPoint[]): string | null {
  if (points.length < 2) return null;
  const values = points
    .map((point) => point.price)
    .filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;

  const width = 280;
  const height = 92;
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

export default function MarketSummaryCard({
  currentMarketPrice,
  change7dPct,
  change30dPct,
  change90dPct,
  volume30d,
  activeListings,
  chartSeries,
  high52w,
  low52w,
  volatility,
}: MarketSummaryCardProps) {
  const sparklinePath = buildSparklinePath(chartSeries);

  return (
    <GroupedSection>
      <GroupCard
        header={
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[15px] font-semibold text-[#f5f7fb]">Market Summary</p>
            </div>
            <Pill label="TCG-linked" tone="neutral" size="small" />
          </div>
        }
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="divide-y divide-white/[0.06] rounded-2xl border border-white/[0.06] bg-[#11151d] px-4">
            <StatRow label="Current Market Price" value={formatUsd(currentMarketPrice)} />
            <StatRow label="7D Change %" value={formatPercent(change7dPct)} />
            <StatRow label="30D Change %" value={formatPercent(change30dPct)} />
            <StatRow label="90D Change %" value={formatPercent(change90dPct)} />
            <StatRow label="Volume (30D)" value={formatInteger(volume30d)} />
            <StatRow label="Active Listings" value={formatInteger(activeListings)} />
          </div>

          <div className="space-y-3">
            <div className="rounded-2xl border border-white/[0.06] bg-[#11151d] p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#8c94a3]">Mini Price Chart</p>
              {sparklinePath ? (
                <svg
                  viewBox="0 0 280 92"
                  className="mt-3 h-24 w-full"
                  role="img"
                  aria-label="30 day price trend"
                  preserveAspectRatio="none"
                >
                  <defs>
                    <linearGradient id="market-summary-spark" x1="0%" x2="100%" y1="0%" y2="0%">
                      <stop offset="0%" stopColor="#8fb6ff" />
                      <stop offset="100%" stopColor="#d4f6e3" />
                    </linearGradient>
                  </defs>
                  <path
                    d={sparklinePath}
                    fill="none"
                    stroke="url(#market-summary-spark)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <div className="mt-3 flex h-24 items-center justify-center rounded-2xl border border-dashed border-white/[0.08] text-[14px] text-[#98a0ae]">
                  N/A
                </div>
              )}
            </div>

            <div className="divide-y divide-white/[0.06] rounded-2xl border border-white/[0.06] bg-[#11151d] px-4">
              <StatRow label="52W High" value={formatUsd(high52w)} />
              <StatRow label="52W Low" value={formatUsd(low52w)} />
              <StatRow label="Volatility" value={formatVolatility(volatility)} />
            </div>
          </div>
        </div>
      </GroupCard>
    </GroupedSection>
  );
}
