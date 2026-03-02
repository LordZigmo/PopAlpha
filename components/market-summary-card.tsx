import CardMarketIntelClient from "@/components/card-market-intel-client";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import {
  breakoutSignalLabel,
  trendSignalLabel,
  valueSignalLabel,
} from "@/lib/signals/scoring";

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

type CardMetricRow = {
  printing_id: string | null;
  active_listings_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
};

type VariantSignalRow = {
  printing_id: string | null;
  signal_trend: number | null;
  signal_breakout: number | null;
  signal_value: number | null;
  history_points_30d: number | null;
  signals_as_of_ts: string | null;
};

function filterRecentDays(points: HistoryPointRow[], days: number): HistoryPointRow[] {
  if (points.length === 0) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return points.filter((point) => {
    const ts = new Date(point.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

export default async function MarketSummaryCard({
  canonicalSlug,
  selectedPrintingId,
  selectedWindow,
  variants,
}: MarketSummaryCardProps) {
  const supabase = getServerSupabaseClient();
  const printingIds = variants.map((variant) => variant.printingId);
  const variantRefs = variants.map((variant) => variant.variantRef);
  const history7dLimit = Math.max(120, variantRefs.length * 60);
  const history30dLimit = Math.max(200, variantRefs.length * 120);
  const history90dLimit = Math.max(400, variantRefs.length * 200);

  const [marketLatestQuery, history7dQuery, history30dQuery, history90dQuery, cardMetricsQuery, variantSignalsQuery] = printingIds.length > 0 && variantRefs.length > 0
    ? await Promise.all([
        supabase
          .from("market_latest")
          .select("printing_id, price_usd, observed_at, updated_at")
          .eq("canonical_slug", canonicalSlug)
          .in("printing_id", printingIds)
          .eq("source", "JUSTTCG")
          .eq("grade", "RAW")
          .eq("price_type", "MARKET")
          .order("updated_at", { ascending: false }),
        supabase
          .from("price_history_points")
          .select("variant_ref, ts, price")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("source_window", "7d")
          .in("variant_ref", variantRefs)
          .order("ts", { ascending: false })
          .limit(history7dLimit),
        supabase
          .from("price_history_points")
          .select("variant_ref, ts, price")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("source_window", "30d")
          .in("variant_ref", variantRefs)
          .order("ts", { ascending: false })
          .limit(history30dLimit),
        supabase
          .from("price_history_points")
          .select("variant_ref, ts, price")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("source_window", "90d")
          .in("variant_ref", variantRefs)
          .order("ts", { ascending: false })
          .limit(history90dLimit),
        supabase
          .from("card_metrics")
          .select("printing_id, active_listings_7d, median_30d, trimmed_median_30d")
          .eq("canonical_slug", canonicalSlug)
          .eq("grade", "RAW")
          .in("printing_id", printingIds),
        supabase
          .from("variant_metrics")
          .select("printing_id, signal_trend, signal_breakout, signal_value, history_points_30d, signals_as_of_ts")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("grade", "RAW")
          .in("printing_id", printingIds),
      ])
    : [
        { data: [] as MarketLatestRow[] },
        { data: [] as HistoryPointRow[] },
        { data: [] as HistoryPointRow[] },
        { data: [] as HistoryPointRow[] },
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

  const history7dRows = (history7dQuery.data ?? []) as Array<HistoryPointRow & { variant_ref?: string }>;
  const history30dRows = (history30dQuery.data ?? []) as Array<HistoryPointRow & { variant_ref?: string }>;
  const history90dRows = (history90dQuery.data ?? []) as Array<HistoryPointRow & { variant_ref?: string }>;

  const buildHistoryMap = (rows: Array<HistoryPointRow & { variant_ref?: string }>) => {
    const map = new Map<string, HistoryPointRow[]>();
    for (const row of rows) {
      const variantRef = row.variant_ref;
      if (!variantRef) continue;
      const current = map.get(variantRef) ?? [];
      current.push({ ts: row.ts, price: row.price });
      map.set(variantRef, current);
    }
    for (const [variantRef, points] of map.entries()) {
      map.set(variantRef, [...points].reverse());
    }
    return map;
  };

  const history7dByVariant = buildHistoryMap(history7dRows);
  const history30dByVariant = buildHistoryMap(history30dRows);
  const history90dByVariant = buildHistoryMap(history90dRows);
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
    const history30d = history30dByVariant.get(variant.variantRef) ?? [];
    const cachedHistory7d = history7dByVariant.get(variant.variantRef) ?? [];
    const history90d = history90dByVariant.get(variant.variantRef) ?? [];
    const signalRow = signalsByPrinting.get(variant.printingId) ?? null;
    const trendScore = signalRow?.signal_trend === null || signalRow?.signal_trend === undefined ? null : Number(signalRow.signal_trend);
    const breakoutScore = signalRow?.signal_breakout === null || signalRow?.signal_breakout === undefined ? null : Number(signalRow.signal_breakout);
    const valueScore = signalRow?.signal_value === null || signalRow?.signal_value === undefined ? null : Number(signalRow.signal_value);
    return {
      printingId: variant.printingId,
      label: variant.label,
      currentPrice: marketLatest?.price_usd ?? null,
      marketBalancePrice:
        cardMetricsByPrinting.get(variant.printingId)?.trimmed_median_30d
        ?? cardMetricsByPrinting.get(variant.printingId)?.median_30d
        ?? null,
      asOfTs: marketLatest?.observed_at ?? marketLatest?.updated_at ?? null,
      history7d: cachedHistory7d.length > 0 ? cachedHistory7d : filterRecentDays(history30d, 7),
      history30d,
      history90d,
      activeListings7d: cardMetricsByPrinting.get(variant.printingId)?.active_listings_7d ?? null,
      signalTrend: trendScore,
      signalTrendLabel: trendScore === null ? null : trendSignalLabel(trendScore),
      signalBreakout: breakoutScore,
      signalBreakoutLabel: breakoutScore === null ? null : breakoutSignalLabel(breakoutScore),
      signalValue: valueScore,
      signalValueLabel: valueScore === null ? null : valueSignalLabel(valueScore),
      signalsHistoryPoints30d:
        signalRow?.history_points_30d === null || signalRow?.history_points_30d === undefined
          ? null
          : Number(signalRow.history_points_30d),
      signalsAsOfTs: signalRow?.signals_as_of_ts ?? null,
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
