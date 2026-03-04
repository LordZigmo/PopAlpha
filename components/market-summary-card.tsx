import CardMarketIntelClient from "@/components/card-market-intel-client";
import { computeLiquidity } from "@/lib/cards/liquidity";
import { dbPublic } from "@/lib/db";
import { getEurToUsdRate } from "@/lib/pricing/fx";

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

type HistoryPointRow = {
  ts: string;
  price: number;
};

type PriceHistoryRow = {
  variant_ref: string | null;
  provider: "JUSTTCG" | "POKEMON_TCG_API" | string;
  currency: string | null;
  ts: string;
  price: number;
};

type FxRateRow = {
  rate: number;
  rate_date: string;
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

function normalizeHistoryPoints(rows: Array<{ ts: string; price: number }>): HistoryPointRow[] {
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
      .select("variant_ref, provider, currency, ts, price")
      .eq("canonical_slug", params.canonicalSlug)
      .in("provider", ["JUSTTCG", "POKEMON_TCG_API"])
      .order("ts", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`public_price_history query failed: ${error.message}`);
    const batch = (data ?? []) as PriceHistoryRow[];
    allRows.push(...batch);
    if (batch.length < pageSize) break;
  }

  return allRows;
}

function toIsoDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

async function loadFxRates(params: {
  supabase: ReturnType<typeof dbPublic>;
  asOfDate: string | null;
}): Promise<FxRateRow[]> {
  if (!params.asOfDate) return [];
  const { data, error } = await params.supabase
    .from("fx_rates")
    .select("rate, rate_date")
    .eq("pair", "EURUSD")
    .lte("rate_date", params.asOfDate)
    .order("rate_date", { ascending: true });
  if (error) return [];
  return (data ?? []) as FxRateRow[];
}

function findRateForDate(fxRows: FxRateRow[], isoDate: string): number | null {
  if (fxRows.length === 0) return null;
  let lo = 0;
  let hi = fxRows.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const rowDate = fxRows[mid]?.rate_date ?? "";
    if (rowDate <= isoDate) {
      best = fxRows[mid]?.rate ?? null;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function convertRowToUsd(row: PriceHistoryRow, fxRows: FxRateRow[]): number | null {
  if (!Number.isFinite(row.price) || row.price <= 0) return null;
  const currency = String(row.currency ?? "USD").trim().toUpperCase();
  if (currency === "USD") return row.price;
  if (currency !== "EUR") return row.price;

  const isoDate = toIsoDate(row.ts);
  const fxRate = (isoDate ? findRateForDate(fxRows, isoDate) : null) ?? getEurToUsdRate();
  if (!Number.isFinite(fxRate) || fxRate <= 0) return null;
  return Number((row.price * fxRate).toFixed(4));
}

function buildMergedHistory(rows: PriceHistoryRow[], fxRows: FxRateRow[]): HistoryPointRow[] {
  if (rows.length === 0) return [];

  const providerBuckets = new Map<string, number[]>();
  for (const row of rows) {
    const parsedTs = new Date(row.ts);
    if (Number.isNaN(parsedTs.getTime())) continue;
    const bucketTs = parsedTs.toISOString();
    const provider = String(row.provider ?? "").toUpperCase();
    if (provider !== "JUSTTCG" && provider !== "POKEMON_TCG_API") continue;
    const usdPrice = convertRowToUsd(row, fxRows);
    if (!Number.isFinite(usdPrice) || usdPrice === null || usdPrice <= 0) continue;
    const key = `${bucketTs}|${provider}`;
    const current = providerBuckets.get(key) ?? [];
    current.push(usdPrice);
    providerBuckets.set(key, current);
  }

  const providerSeries = new Map<string, Array<{ ts: string; ms: number; price: number }>>();
  for (const [key, prices] of providerBuckets.entries()) {
    if (prices.length === 0) continue;
    const [ts, provider] = key.split("|");
    if (!ts || !provider) continue;
    const ms = new Date(ts).getTime();
    if (!Number.isFinite(ms)) continue;
    const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length;
    const arr = providerSeries.get(provider) ?? [];
    arr.push({ ts, ms, price: Number(mean.toFixed(4)) });
    providerSeries.set(provider, arr);
  }

  for (const [provider, points] of providerSeries.entries()) {
    providerSeries.set(provider, [...points].sort((a, b) => a.ms - b.ms));
  }

  const allTimestamps = Array.from(
    new Set(
      [...providerSeries.values()]
        .flat()
        .map((point) => point.ts)
    )
  )
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const providers = [...providerSeries.keys()];
  const pointerByProvider = new Map<string, number>(providers.map((provider) => [provider, 0]));
  const latestByProvider = new Map<string, { ts: string; ms: number; price: number } | null>(providers.map((provider) => [provider, null]));

  // Keep a provider's last reading available for merge for up to 72h so async update cadence
  // doesn't create artificial end-of-line cliffs.
  const MAX_CARRY_FORWARD_MS = 72 * 60 * 60 * 1000;

  const mergedPoints: HistoryPointRow[] = [];
  for (const ts of allTimestamps) {
    const tsMs = new Date(ts).getTime();
    if (!Number.isFinite(tsMs)) continue;

    for (const provider of providers) {
      const series = providerSeries.get(provider) ?? [];
      let pointer = pointerByProvider.get(provider) ?? 0;
      while (pointer < series.length && series[pointer]!.ms <= tsMs) {
        latestByProvider.set(provider, series[pointer]!);
        pointer += 1;
      }
      pointerByProvider.set(provider, pointer);
    }

    const activePrices: number[] = [];
    for (const provider of providers) {
      const latest = latestByProvider.get(provider);
      if (!latest) continue;
      if (tsMs - latest.ms > MAX_CARRY_FORWARD_MS) continue;
      activePrices.push(latest.price);
    }
    if (activePrices.length === 0) continue;
    const merged = activePrices.reduce((sum, value) => sum + value, 0) / activePrices.length;
    mergedPoints.push({ ts, price: Number(merged.toFixed(4)) });
  }

  return mergedPoints;
}

export default async function MarketSummaryCard({
  canonicalSlug,
  selectedPrintingId,
  selectedWindow,
  variants,
}: MarketSummaryCardProps) {
  const supabase = dbPublic();
  const printingIds = variants.map((variant) => variant.printingId);
  const [allHistoryRows, cardMetricsQuery, variantSignalsQuery] = printingIds.length > 0
    ? await Promise.all([
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
        [] as PriceHistoryRow[],
        { data: [] as CardMetricRow[] },
        { data: [] as VariantSignalRow[] },
      ];

  const maxHistoryDate = allHistoryRows
    .map((row) => toIsoDate(row.ts))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const fxRows = await loadFxRates({ supabase, asOfDate: maxHistoryDate });

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
    const rawVariantPrefix = `${variant.printingId}::RAW`;
    const mergedHistory = buildMergedHistory(
      allHistoryRows.filter((row) => {
        const variantRef = row.variant_ref ?? "";
        return variantRef === rawVariantPrefix || variantRef.startsWith(`${rawVariantPrefix}::`);
      }),
      fxRows
    );
    const fullHistory = normalizeHistoryPoints(mergedHistory);
    const history7d = filterRecentDays(fullHistory, 7);
    const history30d = filterRecentDays(fullHistory, 30);
    const history90d = filterRecentDays(fullHistory, 90);
    const latestMergedPoint = fullHistory.at(-1) ?? null;
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
      marketBalancePrice:
        metrics?.trimmed_median_30d
        ?? metrics?.median_30d
        ?? null,
      currentPrice: latestMergedPoint?.price ?? null,
      asOfTs: latestMergedPoint?.ts ?? null,
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
