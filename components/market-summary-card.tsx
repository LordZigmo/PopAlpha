import CardMarketIntelClient from "@/components/card-market-intel-client";
import type {
  HistoryPointRow,
  RawCardMarketVariant,
  RawCardMarketVariantInput,
} from "@/components/raw-card-variant-types";
import { computeLiquidity } from "@/lib/cards/liquidity";
import { dbPublic } from "@/lib/db";
// Phase C-2 (2026-05-16): asking-price lookup reads from
// provider_observation_matches + provider_normalized_observations,
// which are RLS-locked to internal-only (migration
// 20260319161000_phase2_provider_and_mapping_tables_rls.sql). The
// public anon client returns no rows, so we use a service-role
// fetch in a server component scope. Trust contract added to
// scripts/security-guardrails.config.mjs DBADMIN_ALLOWED_FILES.
// Codex P2 on PR #99.
import { dbAdmin } from "@/lib/db/admin";
import {
  extractRawVariantPrintingId,
  isRawHistoryVariantRefForPrinting,
} from "@/lib/identity/variant-ref";
import {
  convertPriceHistoryRowToUsd,
  loadPriceHistoryFxRows,
  type PriceHistoryFxRateRow,
} from "@/lib/pricing/price-history-currency";
import {
  getSharedPrivateSalesForSlug,
  type SharedPrivateSale,
} from "@/lib/data/shared-private-sales";

type MarketSummaryCardProps = {
  canonicalSlug: string;
  selectedPrintingId: string | null;
  selectedWindow: "7d" | "30d" | "90d";
  variants: RawCardMarketVariantInput[];
};

type SupportedProvider = "SCRYDEX";

type PriceHistoryRow = {
  variant_ref: string | null;
  printing_id: string | null;
  provider: string | null;
  currency: string | null;
  ts: string;
  price: number;
};

type CardMetricRow = {
  printing_id: string | null;
  active_listings_7d: number | null;
  market_price: number | null;
  market_price_as_of: string | null;
  market_price_display_state: RawCardMarketVariant["marketPriceDisplayState"] | null;
  recent_market_signal_usd: number | null;
  recent_market_signal_as_of: string | null;
  recent_market_signal_delta_pct: number | null;
  recent_market_signal_direction: RawCardMarketVariant["recentMarketSignalDirection"] | null;
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
      .from("public_price_history_by_printing")
      .select("variant_ref, printing_id, provider, currency, ts, price")
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

function convertRowToUsd(row: PriceHistoryRow, fxRows: PriceHistoryFxRateRow[]): number | null {
  return convertPriceHistoryRowToUsd(row, fxRows);
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

function buildProviderSeries(rows: PriceHistoryRow[], fxRows: PriceHistoryFxRateRow[]): ProviderSeries[] {
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
    .filter((entry) => (
      entry.provider === provider
      && isRawHistoryVariantRefForPrinting(entry.variantRef, input.printingId)
    ))
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
  const visiblePrintingIds = new Set(printingIds);
  if (printingIds.length === 0) return [];

  const [allHistoryRows, cardMetricsQuery, variantSignalsQuery, askingPriceQuery] = await Promise.all([
    loadAllHistoryRows({ supabase, canonicalSlug: params.canonicalSlug }),
    supabase
      .from("public_card_metrics")
      .select([
        "printing_id",
        "active_listings_7d",
        "market_price",
        "market_price_as_of",
        "market_price_display_state",
        "recent_market_signal_usd",
        "recent_market_signal_as_of",
        "recent_market_signal_delta_pct",
        "recent_market_signal_direction",
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
    // Phase C-2 (2026-05-16): asking-anchored value per printing,
    // pulled from the latest scrydex observation's metadata. The
    // normalizer (lib/backfill/pokemontcg-raw-normalize.ts) writes
    // metadata.scrydexAskingPriceUsd at observation time.
    //
    // Per-printing parallel queries so each printing gets a fair shot
    // at finding its latest observation. A single global query with
    // limit (the earlier approach) was unfair: if one printing had
    // many recent observations they could crowd out other printings
    // within the global cap, leaving their asking metadata invisible.
    // Codex P2 #3 on PR #99.
    //
    // Uses dbAdmin() because provider_observation_matches +
    // provider_normalized_observations are RLS-locked to internal-only
    // (migration 20260319161000). The anon client would return zero
    // rows silently and the asking line would never appear. The
    // service-role read is safe here — only metadata.scrydexAskingPriceUsd
    // is extracted from the response (already non-sensitive pricing
    // data that we surface to the user). Codex P2 #1 on PR #99.
    //
    // Each query asks for the 2 latest non-graded observations on a
    // single printing. 2 covers per-finish splits (holofoil vs
    // reverseHolofoil get distinct provider_variant_id values) without
    // over-fetching.
    Promise.all(
      printingIds.map((printingId) =>
        dbAdmin()
          .from("provider_observation_matches")
          .select("printing_id, updated_at, provider_variant_id, provider_normalized_observations(metadata, observed_at)")
          .eq("canonical_slug", params.canonicalSlug)
          .eq("provider", "SCRYDEX")
          .eq("printing_id", printingId)
          // Filter out graded observations at the query level. Graded
          // observations get suffix "::GRADED::<PROVIDER>::<BUCKET>"
          // on provider_variant_id (see pokemontcg-raw-normalize.ts
          // line 327's comment). Without this filter, cards with
          // multiple graded SKUs can crowd out the RAW observation
          // even with the per-printing limit. Codex P2 #2 on PR #99.
          .not("provider_variant_id", "ilike", "%::GRADED::%")
          .order("updated_at", { ascending: false })
          .limit(2),
      ),
    ),
  ]);

  const maxHistoryDate = allHistoryRows
    .map((row) => toIsoDate(row.ts))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const fxRows = await loadPriceHistoryFxRows(supabase, maxHistoryDate);

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
    const rawPrintingId = extractRawVariantPrintingId(row.variant_ref);
    const printingId = rawPrintingId ?? row.printing_id;
    if (!printingId || !visiblePrintingIds.has(printingId)) continue;
    if (!rawPrintingId) continue;
    const current = historyRowsByPrinting.get(printingId) ?? [];
    current.push(row);
    historyRowsByPrinting.set(printingId, current);
  }

  // Phase C-2 (2026-05-16): per-printing asking-anchored USD value
  // map. `askingPriceQuery` is an array of query results (one per
  // printing — see the Promise.all in the fetch block). Each per-
  // printing result is already ordered by updated_at desc, so the
  // first row with a non-null scrydexAskingPriceUsd in that printing's
  // result is the latest valid match.
  type AskingPriceJoinRow = {
    printing_id: string | null;
    provider_normalized_observations:
      | { metadata: Record<string, unknown> | null; observed_at: string | null }
      | null;
  };
  const askingPriceByPrinting = new Map<string, number>();
  for (const printingResult of askingPriceQuery) {
    for (const row of (printingResult.data ?? []) as unknown as AskingPriceJoinRow[]) {
      if (!row.printing_id) continue;
      if (askingPriceByPrinting.has(row.printing_id)) continue;
      const meta = row.provider_normalized_observations?.metadata ?? null;
      const value = meta && typeof meta === "object" ? meta["scrydexAskingPriceUsd"] : null;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        askingPriceByPrinting.set(row.printing_id, value);
      }
    }
  }

  return params.variants.map((variant) => {
    const printingHistoryRows = historyRowsByPrinting.get(variant.printingId) ?? [];
    const series = buildProviderSeries(printingHistoryRows, fxRows);
    const scrydexSeries = chooseProviderSeries(series, "SCRYDEX", variant);
    const preferredHistory = scrydexSeries?.points ?? [];
    const metrics = cardMetricsByPrinting.get(variant.printingId) ?? null;
    const signalRow = chooseSignalRow(signalRowsByPrinting.get(variant.printingId) ?? []);
    const liveMarketPrice = metrics?.market_price ?? null;
    const hasLivePrice = liveMarketPrice !== null;
    const liveMarketAsOfTs = hasLivePrice ? (metrics?.market_price_as_of ?? null) : null;

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
      currentPrice: liveMarketPrice,
      changePct7d: metrics?.change_pct_7d ?? null,
      justtcgPrice: null,
      justtcgAsOfTs: null,
      scrydexPrice: liveMarketPrice,
      scrydexAsOfTs: liveMarketAsOfTs,
      // Phase C-2 (2026-05-16): asking-anchored auxiliary value. Only
      // surface when distinguishably above the headline (≥10% gap) so
      // the line doesn't add noise on cards where low ≈ market. UI
      // hides the line when this is null OR when the spread is
      // negligible. See raw-card-market-surface render.
      scrydexAskingHighUsd: hasLivePrice ? (askingPriceByPrinting.get(variant.printingId) ?? null) : null,
      marketBalancePrice: metrics?.trimmed_median_30d ?? metrics?.median_30d ?? null,
      marketPriceDisplayState: metrics?.market_price_display_state ?? null,
      recentMarketSignalUsd: hasLivePrice ? (metrics?.recent_market_signal_usd ?? null) : null,
      recentMarketSignalAsOf: hasLivePrice ? (metrics?.recent_market_signal_as_of ?? null) : null,
      recentMarketSignalDeltaPct: hasLivePrice ? (metrics?.recent_market_signal_delta_pct ?? null) : null,
      recentMarketSignalDirection: hasLivePrice ? (metrics?.recent_market_signal_direction ?? null) : null,
      asOfTs: liveMarketAsOfTs,
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
      signalsAsOfTs: hasLivePrice ? liveMarketAsOfTs : null,
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

  // Anchor outlier filter on the median market price across the variants
  // we resolved above (whichever has data). Falls back to no median →
  // OUTLIER_BAND short-circuits and keeps all opted-in sales.
  const marketMedianUsd =
    variantPayload
      .map((variant) => variant.marketBalancePrice)
      .find((value): value is number => Number.isFinite(value) && (value ?? 0) > 0)
    ?? null;

  let sharedSales: SharedPrivateSale[] = [];
  try {
    sharedSales = await getSharedPrivateSalesForSlug({
      canonicalSlug,
      marketMedianUsd,
    });
  } catch (error) {
    console.error("[MarketSummaryCard] shared sales load failed:",
      error instanceof Error ? error.message : String(error));
  }

  return (
    <CardMarketIntelClient
      variants={variantPayload}
      selectedPrintingId={selectedPrintingId}
      selectedWindow={selectedWindow}
      sharedSales={sharedSales}
    />
  );
}
