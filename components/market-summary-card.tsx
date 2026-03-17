import CardMarketIntelClient from "@/components/card-market-intel-client";
import type {
  HistoryPointRow,
  RawCardMarketVariant,
  RawCardMarketVariantInput,
} from "@/components/raw-card-variant-types";
import { computeLiquidity } from "@/lib/cards/liquidity";
import { dbPublic } from "@/lib/db";
import { getEurToUsdRate } from "@/lib/pricing/fx";

type MarketSummaryCardProps = {
  canonicalSlug: string;
  selectedPrintingId: string | null;
  selectedWindow: "7d" | "30d" | "90d";
  variants: RawCardMarketVariantInput[];
};

type SupportedProvider = "SCRYDEX";

type PriceHistoryRow = {
  variant_ref: string | null;
  provider: string | null;
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
  market_price: number | null;
  market_price_as_of: string | null;
  change_pct_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
  snapshot_count_30d: number | null;
  provider_price_changes_count_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
};

type VariantSignalRow = {
  printing_id: string | null;
  provider: string | null;
  provider_as_of_ts: string | null;
  history_points_30d: number | null;
  provider_trend_slope_7d: number | null;
};

type ProviderSeries = {
  provider: SupportedProvider;
  variantRef: string;
  points: HistoryPointRow[];
  latestTs: string | null;
  score: number;
};

function filterRecentDays(points: HistoryPointRow[], days: number): HistoryPointRow[] {
  if (points.length === 0) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return points.filter((point) => {
    const ts = new Date(point.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

function normalizeHistoryPoints(rows: HistoryPointRow[]): HistoryPointRow[] {
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

function normalizeProviderName(provider: string | null | undefined): SupportedProvider | null {
  const normalized = String(provider ?? "").trim().toUpperCase();
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  return null;
}

function toIsoDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

async function loadAllHistoryRows(params: {
  supabase: ReturnType<typeof dbPublic>;
  canonicalSlug: string;
}): Promise<PriceHistoryRow[]> {
  const pageSize = 1000;
  const allRows: PriceHistoryRow[] = [];
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await params.supabase
      .from("public_price_history")
      .select("variant_ref, provider, currency, ts, price")
      .eq("canonical_slug", params.canonicalSlug)
      .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
      .gte("ts", since)
      .order("ts", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`public_price_history query failed: ${error.message}`);
    const batch = (data ?? []) as PriceHistoryRow[];
    allRows.push(...batch);
    if (batch.length < pageSize) break;
  }

  return allRows;
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

function historyPrintingId(variantRef: string | null | undefined): string | null {
  const rawValue = String(variantRef ?? "").trim();
  if (!rawValue.includes("::")) return null;
  return rawValue.split("::")[0] ?? null;
}

function historyToken(variantRef: string | null | undefined): string {
  const rawValue = String(variantRef ?? "").trim();
  if (!rawValue) return "";
  const parts = rawValue.split("::");
  const source = parts.length >= 3 ? parts[1] : rawValue;
  const trailing = source.split(":").at(-1) ?? source;
  return trailing.replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function expectedStampToken(stamp: string | null): string | null {
  switch (String(stamp ?? "").trim().toUpperCase()) {
    case "POKE_BALL_PATTERN":
      return "pokeball";
    case "MASTER_BALL_PATTERN":
      return "masterball";
    case "DUSK_BALL_PATTERN":
      return "duskball";
    case "QUICK_BALL_PATTERN":
      return "quickball";
    case "ENERGY_PATTERN":
      return "energy";
    case "ROCKET_PATTERN":
      return "rocket";
    case "POKEMON_CENTER":
      return "pokemoncenter";
    case "W_STAMP":
      return "wstamp";
    case "PRERELEASE_STAMP":
      return "prerelease";
    default:
      return null;
  }
}

function hasSpecialStampToken(token: string): boolean {
  return [
    "pokeball",
    "masterball",
    "duskball",
    "quickball",
    "energy",
    "rocket",
    "pokemoncenter",
    "wstamp",
    "prerelease",
  ].some((value) => token.includes(value));
}

function providerVariantMatchScore(
  provider: SupportedProvider,
  variantRef: string,
  input: RawCardMarketVariantInput,
): number {
  if (provider !== "SCRYDEX") return 0;

  const token = historyToken(variantRef);
  if (!token) return 0;

  let score = 0;
  const expectedEdition = input.edition === "FIRST_EDITION" ? "FIRST_EDITION" : "UNLIMITED";
  const expectedFinish = input.finish;
  const stampToken = expectedStampToken(input.stamp);

  if (expectedEdition === "FIRST_EDITION") {
    score += token.includes("firstedition") || token.includes("1stedition") ? 300 : -300;
  } else {
    score += token.includes("firstedition") || token.includes("1stedition") ? -300 : 150;
  }

  if (stampToken) {
    score += token.includes(stampToken) ? 500 : -500;
  } else {
    score += hasSpecialStampToken(token) ? -350 : 150;
  }

  if (expectedFinish === "NON_HOLO") {
    if (["normal", "nonholo", "nonholofoil", "unlimited", "unlimitedshadowless"].includes(token)) score += 400;
    else if (token.includes("reverse")) score -= 250;
    else if (token.includes("holo") || token.includes("foil")) score -= 200;
    else score += 40;
  } else if (expectedFinish === "REVERSE_HOLO") {
    if (token.includes("reverse")) score += 400;
    else if (token.includes("holo") || token.includes("foil")) score += 50;
    else if (token === "normal" || token.includes("nonholo")) score -= 250;
  } else if (expectedFinish === "HOLO") {
    if (stampToken && token.includes(stampToken)) score += 350;
    else if (token.includes("reverse")) score -= 150;
    else if (token.includes("holo") || token.includes("foil")) score += 350;
    else if (token === "normal" || token.includes("nonholo")) score -= 250;
  } else if (token === "normal") {
    score += 50;
  }

  if (token === "normal") score += 40;
  else if (token === "holofoil") score += 20;
  else if (token === "reverseholofoil") score += 20;

  return score;
}

function buildProviderSeries(rows: PriceHistoryRow[], fxRows: FxRateRow[]): ProviderSeries[] {
  const seriesByKey = new Map<string, ProviderSeries>();

  for (const row of rows) {
    const provider = normalizeProviderName(row.provider);
    const variantRef = String(row.variant_ref ?? "").trim();
    if (!provider || !variantRef) continue;
    const price = convertRowToUsd(row, fxRows);
    if (!Number.isFinite(price) || price === null || price <= 0) continue;

    const key = `${provider}|${variantRef}`;
    const current = seriesByKey.get(key) ?? {
      provider,
      variantRef,
      points: [],
      latestTs: null,
      score: 0,
    };
    current.points.push({ ts: row.ts, price });
    if (!current.latestTs || row.ts > current.latestTs) current.latestTs = row.ts;
    seriesByKey.set(key, current);
  }

  return [...seriesByKey.values()].map((entry) => ({
    ...entry,
    points: normalizeHistoryPoints(entry.points),
  }));
}

function compareIsoDesc(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
}

function chooseProviderSeries(
  series: ProviderSeries[],
  provider: SupportedProvider,
  input: RawCardMarketVariantInput,
): ProviderSeries | null {
  const canonicalRef = `${input.printingId}::RAW`;
  const candidates = series
    .filter((entry) => entry.provider === provider)
    .map((entry) => ({
      ...entry,
      score:
        (entry.variantRef === canonicalRef ? 1000 : 0)
        + providerVariantMatchScore(provider, entry.variantRef, input),
    }));

  if (candidates.length === 0) return null;

  return [...candidates].sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    const tsDelta = compareIsoDesc(left.latestTs, right.latestTs);
    if (tsDelta !== 0) return tsDelta;
    const pointDelta = right.points.length - left.points.length;
    if (pointDelta !== 0) return pointDelta;
    return left.variantRef.localeCompare(right.variantRef);
  })[0] ?? null;
}

function chooseSignalRow(rows: VariantSignalRow[]): VariantSignalRow | null {
  const supportedRows = rows.filter((row) => normalizeProviderName(row.provider) !== null);
  if (supportedRows.length === 0) return null;

  return [...supportedRows].sort((left, right) => {
    const leftProvider = normalizeProviderName(left.provider);
    const rightProvider = normalizeProviderName(right.provider);
    if (leftProvider !== rightProvider) {
      return leftProvider === "SCRYDEX" ? -1 : 1;
    }
    const tsDelta = compareIsoDesc(left.provider_as_of_ts, right.provider_as_of_ts);
    if (tsDelta !== 0) return tsDelta;
    return (right.history_points_30d ?? 0) - (left.history_points_30d ?? 0);
  })[0] ?? null;
}

export async function loadRawCardMarketVariants(params: {
  canonicalSlug: string;
  variants: RawCardMarketVariantInput[];
}): Promise<RawCardMarketVariant[]> {
  const supabase = dbPublic();
  const printingIds = params.variants.map((variant) => variant.printingId);
  if (printingIds.length === 0) return [];

  const [allHistoryRows, cardMetricsQuery, variantSignalsQuery] = await Promise.all([
    loadAllHistoryRows({ supabase, canonicalSlug: params.canonicalSlug }),
    supabase
      .from("public_card_metrics")
      .select([
        "printing_id",
        "active_listings_7d",
        "market_price",
        "market_price_as_of",
        "change_pct_7d",
        "median_30d",
        "trimmed_median_30d",
        "snapshot_count_30d",
        "provider_price_changes_count_30d",
        "low_30d",
        "high_30d",
      ].join(", "))
      .eq("canonical_slug", params.canonicalSlug)
      .eq("grade", "RAW")
      .in("printing_id", printingIds),
    supabase
      .from("public_variant_metrics")
      .select("printing_id, provider, provider_as_of_ts, history_points_30d, provider_trend_slope_7d")
      .eq("canonical_slug", params.canonicalSlug)
      .eq("grade", "RAW")
      .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
      .in("printing_id", printingIds),
  ]);

  const maxHistoryDate = allHistoryRows
    .map((row) => toIsoDate(row.ts))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const fxRows = await loadFxRates({ supabase, asOfDate: maxHistoryDate });

  const cardMetricsByPrinting = new Map<string, CardMetricRow>();
  for (const row of (cardMetricsQuery.data ?? []) as unknown as CardMetricRow[]) {
    if (!row.printing_id || cardMetricsByPrinting.has(row.printing_id)) continue;
    cardMetricsByPrinting.set(row.printing_id, row);
  }

  const signalRowsByPrinting = new Map<string, VariantSignalRow[]>();
  for (const row of (variantSignalsQuery.data ?? []) as unknown as VariantSignalRow[]) {
    if (!row.printing_id) continue;
    const current = signalRowsByPrinting.get(row.printing_id) ?? [];
    current.push(row);
    signalRowsByPrinting.set(row.printing_id, current);
  }

  const historyRowsByPrinting = new Map<string, PriceHistoryRow[]>();
  for (const row of allHistoryRows) {
    const printingId = historyPrintingId(row.variant_ref);
    if (!printingId) continue;
    const current = historyRowsByPrinting.get(printingId) ?? [];
    current.push(row);
    historyRowsByPrinting.set(printingId, current);
  }

  return params.variants.map((variant) => {
    const printingHistoryRows = historyRowsByPrinting.get(variant.printingId) ?? [];
    const series = buildProviderSeries(printingHistoryRows, fxRows);
    const scrydexSeries = chooseProviderSeries(series, "SCRYDEX", variant);
    const preferredSeries = scrydexSeries ?? series[0] ?? null;
    const preferredHistory = preferredSeries?.points ?? [];
    const metrics = cardMetricsByPrinting.get(variant.printingId) ?? null;
    const signalRow = chooseSignalRow(signalRowsByPrinting.get(variant.printingId) ?? []);
    const liveScrydexPrice = metrics?.market_price ?? null;
    const hasLivePrice = liveScrydexPrice !== null;
    const liveScrydexAsOfTs = hasLivePrice ? (metrics?.market_price_as_of ?? null) : null;

    const liquidity = computeLiquidity({
      priceChanges30d: metrics?.provider_price_changes_count_30d ?? null,
      snapshotCount30d: metrics?.snapshot_count_30d ?? null,
      low30d: metrics?.low_30d ?? null,
      high30d: metrics?.high_30d ?? null,
      median30d: metrics?.median_30d ?? null,
    });

    return {
      printingId: variant.printingId,
      label: variant.label,
      descriptorLabel: variant.descriptorLabel,
      imageUrl: variant.imageUrl,
      rarity: variant.rarity,
      currentPrice: liveScrydexPrice,
      changePct7d: metrics?.change_pct_7d ?? null,
      justtcgPrice: null,
      justtcgAsOfTs: null,
      scrydexPrice: liveScrydexPrice,
      scrydexAsOfTs: liveScrydexAsOfTs,
      marketBalancePrice: metrics?.trimmed_median_30d ?? metrics?.median_30d ?? null,
      asOfTs: liveScrydexAsOfTs,
      trendSlope7d: signalRow?.provider_trend_slope_7d ?? null,
      history7d: filterRecentDays(preferredHistory, 7),
      history30d: filterRecentDays(preferredHistory, 30),
      history90d: filterRecentDays(preferredHistory, 90),
      activeListings7d: hasLivePrice ? (metrics?.active_listings_7d ?? null) : null,
      signalTrend: null,
      signalTrendLabel: null,
      signalBreakout: null,
      signalBreakoutLabel: null,
      signalValue: null,
      signalValueLabel: null,
      signalsHistoryPoints30d: hasLivePrice ? (metrics?.snapshot_count_30d ?? null) : null,
      signalsAsOfTs: hasLivePrice ? liveScrydexAsOfTs : null,
      liquidityScore: hasLivePrice ? (liquidity?.score ?? null) : null,
      liquidityTier: hasLivePrice ? (liquidity?.tier ?? null) : null,
      liquidityTone: liquidity?.tone ?? "neutral",
      liquidityPriceChanges30d: hasLivePrice ? (metrics?.provider_price_changes_count_30d ?? null) : null,
      liquiditySnapshotCount30d: hasLivePrice ? (metrics?.snapshot_count_30d ?? null) : null,
      liquiditySpreadPercent: hasLivePrice ? (liquidity?.spreadPercent ?? null) : null,
    };
  });
}

export default async function MarketSummaryCard({
  canonicalSlug,
  selectedPrintingId,
  selectedWindow,
  variants,
}: MarketSummaryCardProps) {
  const variantPayload = await loadRawCardMarketVariants({
    canonicalSlug,
    variants,
  });

  return (
    <CardMarketIntelClient
      variants={variantPayload}
      selectedPrintingId={selectedPrintingId}
      selectedWindow={selectedWindow}
    />
  );
}
