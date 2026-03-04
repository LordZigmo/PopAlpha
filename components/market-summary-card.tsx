import CardMarketIntelClient from "@/components/card-market-intel-client";
import { computeLiquidity } from "@/lib/cards/liquidity";
import { dbPublic } from "@/lib/db";

type MarketSummaryCardProps = {
  canonicalSlug: string;
  selectedPrintingId: string | null;
  selectedWindow: "7d" | "30d" | "90d";
  variants: Array<{
    printingId: string;
    label: string;
    variantRef: string;
  }>;
};

type MarketLatestRow = {
  printing_id: string | null;
  price_usd: number | null;
  observed_at: string | null;
  updated_at: string | null;
};

type HistoryPointRow = {
  ts: string;
  price: number;
};

type PriceHistoryRow = {
  variant_ref: string | null;
  ts: string;
  price: number;
};

type CardMetricRow = {
  printing_id: string | null;
  active_listings_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
  snapshot_count_30d: number | null;
  provider_price_changes_count_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
};

type VariantSignalRow = {
  printing_id: string | null;
  history_points_30d: number | null;
  provider_trend_slope_7d: number | null;
};

function filterRecentDays(points: HistoryPointRow[], days: number): HistoryPointRow[] {
  if (points.length === 0) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return points.filter((point) => {
    const ts = new Date(point.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

function normalizeHistoryPoints(rows: PriceHistoryRow[]): HistoryPointRow[] {
  if (rows.length === 0) return [];
  const dedupedByTs = new Map<string, number>();
  for (const row of rows) {
    if (!row.ts || !Number.isFinite(row.price)) continue;
    dedupedByTs.set(row.ts, row.price);
  }
  return [...dedupedByTs.entries()]
    .map(([ts, price]) => ({ ts, price }))
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

async function loadAllHistoryRows(params: {
  supabase: ReturnType<typeof dbPublic>;
  canonicalSlug: string;
}): Promise<PriceHistoryRow[]> {
  const pageSize = 1000;
  const allRows: PriceHistoryRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await params.supabase
      .from("public_price_history")
      .select("variant_ref, ts, price")
      .eq("canonical_slug", params.canonicalSlug)
      .eq("provider", "JUSTTCG")
      .order("ts", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`public_price_history query failed: ${error.message}`);
    const batch = (data ?? []) as PriceHistoryRow[];
    allRows.push(...batch);
    if (batch.length < pageSize) break;
  }

  return allRows;
}

export default async function MarketSummaryCard({
  canonicalSlug,
  selectedPrintingId,
  selectedWindow,
  variants,
}: MarketSummaryCardProps) {
  const supabase = dbPublic();
  const printingIds = variants.map((variant) => variant.printingId);
  const [marketLatestQuery, allHistoryRows, cardMetricsQuery, variantSignalsQuery] = printingIds.length > 0
    ? await Promise.all([
        supabase
          .from("public_market_latest")
          .select("printing_id, price_usd, observed_at, updated_at")
          .eq("canonical_slug", canonicalSlug)
          .in("printing_id", printingIds)
          .eq("source", "JUSTTCG")
          .eq("grade", "RAW")
          .eq("price_type", "MARKET")
          .order("updated_at", { ascending: false }),
        loadAllHistoryRows({ supabase, canonicalSlug }),
        supabase
          .from("public_card_metrics")
          .select("printing_id, active_listings_7d, median_30d, trimmed_median_30d, snapshot_count_30d, provider_price_changes_count_30d, low_30d, high_30d")
          .eq("canonical_slug", canonicalSlug)
          .eq("grade", "RAW")
          .in("printing_id", printingIds),
        supabase
          .from("public_variant_metrics")
          .select("printing_id, history_points_30d, provider_trend_slope_7d")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("grade", "RAW")
          .in("printing_id", printingIds),
      ])
    : [
        { data: [] as MarketLatestRow[] },
        [] as PriceHistoryRow[],
        { data: [] as CardMetricRow[] },
        { data: [] as VariantSignalRow[] },
      ];

  const marketLatestRows = (marketLatestQuery.data ?? []) as MarketLatestRow[];
  const latestByPrinting = new Map<string, MarketLatestRow>();
  for (const row of marketLatestRows) {
    const printingId = row.printing_id;
    if (!printingId || latestByPrinting.has(printingId)) continue;
    latestByPrinting.set(printingId, row);
  }

  const cardMetricRows = (cardMetricsQuery.data ?? []) as CardMetricRow[];
  const signalRows = (variantSignalsQuery.data ?? []) as VariantSignalRow[];
  const cardMetricsByPrinting = new Map<string, CardMetricRow>();
  for (const row of cardMetricRows) {
    if (!row.printing_id || cardMetricsByPrinting.has(row.printing_id)) continue;
    cardMetricsByPrinting.set(row.printing_id, row);
  }
  const signalsByPrinting = new Map<string, VariantSignalRow>();
  for (const row of signalRows) {
    if (!row.printing_id || signalsByPrinting.has(row.printing_id)) continue;
    signalsByPrinting.set(row.printing_id, row);
  }

  const variantPayload = variants.map((variant) => {
    const marketLatest = latestByPrinting.get(variant.printingId) ?? null;
    const rawVariantPrefix = `${variant.printingId}::RAW`;
    const fullHistory = normalizeHistoryPoints(
      allHistoryRows.filter((row) => {
        const variantRef = row.variant_ref ?? "";
        return variantRef === rawVariantPrefix || variantRef.startsWith(`${rawVariantPrefix}::`);
      })
    );
    const history7d = filterRecentDays(fullHistory, 7);
    const history30d = filterRecentDays(fullHistory, 30);
    const history90d = filterRecentDays(fullHistory, 90);
    const signalRow = signalsByPrinting.get(variant.printingId) ?? null;
    const metrics = cardMetricsByPrinting.get(variant.printingId) ?? null;

    const liq = computeLiquidity({
      priceChanges30d: metrics?.provider_price_changes_count_30d ?? null,
      snapshotCount30d: metrics?.snapshot_count_30d ?? null,
      low30d: metrics?.low_30d ?? null,
      high30d: metrics?.high_30d ?? null,
      median30d: metrics?.median_30d ?? null,
    });

    // Signal columns are paywalled — always null from public views.
    return {
      printingId: variant.printingId,
      label: variant.label,
      currentPrice: marketLatest?.price_usd ?? null,
      marketBalancePrice:
        metrics?.trimmed_median_30d
        ?? metrics?.median_30d
        ?? null,
      asOfTs: marketLatest?.observed_at ?? marketLatest?.updated_at ?? null,
      history7d,
      history30d,
      history90d,
      activeListings7d: metrics?.active_listings_7d ?? null,
      signalTrend: null,
      signalTrendLabel: null,
      signalBreakout: null,
      signalBreakoutLabel: null,
      signalValue: null,
      signalValueLabel: null,
      trendSlope7d: signalRow?.provider_trend_slope_7d ?? null,
      signalsHistoryPoints30d:
        signalRow?.history_points_30d === null || signalRow?.history_points_30d === undefined
          ? null
          : Number(signalRow.history_points_30d),
      signalsAsOfTs: null,
      liquidityScore: liq?.score ?? null,
      liquidityTier: liq?.tier ?? null,
      liquidityTone: liq?.tone ?? "neutral" as const,
      liquidityPriceChanges30d: metrics?.provider_price_changes_count_30d ?? null,
      liquiditySnapshotCount30d: metrics?.snapshot_count_30d ?? null,
      liquiditySpreadPercent: liq?.spreadPercent ?? null,
    };
  });

  return (
    <CardMarketIntelClient
      variants={variantPayload}
      selectedPrintingId={selectedPrintingId}
      selectedWindow={selectedWindow}
    />
  );
}
