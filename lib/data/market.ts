import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type RawParityStatus,
} from "@/lib/pricing/market-confidence";
import {
  computeCanonicalMarketStrength,
  type MarketDirection,
} from "@/lib/data/market-strength";
import {
  computeJpNativeConfidence,
  isJpNativeCoverageSource,
  loadJpPriceCoverageMap,
  type JpPriceCoverage,
  type JpPriceCoverageSource,
} from "@/lib/data/jp-price-coverage";

export type MarketChangeWindow = "24H" | "7D";

export type MarketBlendPolicy =
  | "NO_PRICE"
  | "SCRYDEX_PRIMARY"
  | "YAHOO_JP_PRIMARY"
  | "SNKRDUNK_PRIMARY"
  | "POPALPHA_MARKET_CONFIDENT"
  | "POPALPHA_MARKET_SINGLE_SOURCE"
  // EN-RAW cheap diverged floor: two sources disagree but the card is
  // low-dollar (greatest <= $2), so we surface the conservative lower price at
  // confidence 25, low-confidence, no change badge. 20260620120000.
  | "POPALPHA_MARKET_CHEAP_DIVERGED_FLOOR"
  | "POPALPHA_MARKET_LOW_CONFIDENCE"
  | "POPALPHA_MARKET_QUARANTINED"
  | "NO_RELIABLE_PRICE"
  | "OUTLIER_SUPPRESSED";

export type MarketPriceDisplayState =
  | "ALIGNED"
  | "SIGNAL_HIGHER"
  | "SIGNAL_LOWER"
  | "PUBLIC_ONLY"
  | "PRICECHARTING_SINGLE_SOURCE"
  // EN-RAW cheap diverged floor (see POPALPHA_MARKET_CHEAP_DIVERGED_FLOOR).
  // 20260620120000.
  | "PRICECHARTING_CHEAP_DIVERGED"
  // Thin JP series (max in-window sample_count < 3): price shown under the
  // single-source trust grammar (confidence 30, low-confidence, no change
  // badge). 20260614150000.
  | "JP_LOW_SAMPLE"
  | "UNDER_REVIEW"
  | "NO_RELIABLE_PRICE";

export type MarketProvenance = {
  trustedPriceSource?: "SCRYDEX" | null;
  trustStatus?: string | null;
  confidenceStatus?: "HIGH" | "LOW" | "QUARANTINED" | "NONE" | string | null;
  publicInputStatus?: "SUPPORTED" | "QUARANTINED" | "INSUFFICIENT_PUBLIC_INPUT" | string | null;
  priceConflictStatus?: "CONSISTENT" | "PUBLIC_INPUT_ONLY" | "INTERNAL_GUARDRAIL_DIVERGED" | "NONE" | string | null;
  internalGuardrailStatus?: "CONSISTENT" | "DIVERGED" | "PRIVATE_ONLY" | "NOT_AVAILABLE" | string | null;
  movementHistorySource?: "PERMITTED_MARKET_INPUT" | string | null;
  parityStatus?: RawParityStatus | string | null;
  sourceMix?: {
    scrydexWeight?: number;
    publicInputWeight?: number;
    jpNativeWeight?: number;
  };
  sampleCounts7d?: {
    scrydex?: number | string;
    public?: number | string;
    jpNative?: number | string;
    total?: number | string;
  };
  marketPriceDisplayState?: MarketPriceDisplayState | string | null;
  recentMarketSignalDirection?: "HIGHER" | "LOWER" | string | null;
  recentMarketSignalDeltaPct?: number | string | null;
};

type CanonicalMarketMetricRow = {
  canonical_slug: string;
  scrydex_price: number | null;
  pokemontcg_price?: number | null;
  market_price: number | null;
  market_price_as_of?: string | null;
  latest_price?: number | null;
  latest_price_as_of?: string | null;
  liquidity_score?: number | null;
  active_listings_7d?: number | null;
  snapshot_count_30d?: number | null;
  median_7d: number | null;
  provider_trend_slope_7d?: number | null;
  provider_cov_price_30d?: number | null;
  provider_price_relative_to_30d_range?: number | null;
  provider_price_changes_count_30d?: number | null;
  market_confidence_score?: number | null;
  market_low_confidence?: boolean | null;
  market_blend_policy?: MarketBlendPolicy | null;
  market_provenance?: MarketProvenance | null;
  change_pct_24h: number | null;
  change_pct_7d: number | null;
  display_price_source?: JpPriceCoverageSource | null;
  display_price_usd?: number | null;
  display_price_as_of?: string | null;
  display_price_sample_count?: number | null;
  market_price_display_state?: MarketPriceDisplayState | string | null;
  recent_market_signal_usd?: number | null;
  recent_market_signal_as_of?: string | null;
  recent_market_signal_delta_pct?: number | null;
  recent_market_signal_direction?: "HIGHER" | "LOWER" | string | null;
};

type CanonicalParityRow = {
  canonical_slug: string;
  parity_status: "MATCH" | "MISMATCH" | "MISSING_PROVIDER" | "UNKNOWN";
};

type CanonicalVariantSignalRow = {
  canonical_slug: string;
  provider: string | null;
  provider_trend_slope_7d?: number | null;
  provider_cov_price_30d?: number | null;
  provider_price_relative_to_30d_range?: number | null;
  provider_price_changes_count_30d?: number | null;
  history_points_30d?: number | null;
  provider_as_of_ts?: string | null;
  updated_at?: string | null;
};

export type CanonicalMarketPulse = {
  scrydexPrice: number | null;
  pokemontcgPrice: number | null;
  marketPrice: number | null;
  marketPriceAsOf?: string | null;
  // Freshest hero price (public_card_metrics.latest_price). The homepage shows
  // this as the card price so it matches the detail hero; falls back to
  // marketPrice (the median) when no freshest point exists. For JP-native rows
  // the source price is already the freshest, so latestPrice == marketPrice.
  latestPrice?: number | null;
  latestPriceAsOf?: string | null;
  liquidityScore?: number | null;
  activeListings7d?: number | null;
  snapshotCount30d?: number | null;
  changePct24h: number | null;
  changePct7d: number | null;
  changePct: number | null;
  changeWindow: MarketChangeWindow | null;
  parityStatus: RawParityStatus;
  blendPolicy?: MarketBlendPolicy;
  confidenceScore?: number;
  lowConfidence?: boolean;
  marketStrengthScore?: number | null;
  marketDirection?: MarketDirection | null;
  priceSource?: "market" | "yahoo_jp" | "snkrdunk" | null;
  trustedPriceSource?: "SCRYDEX" | null;
  trustStatus?: string | null;
  confidenceStatus?: string | null;
  publicInputStatus?: string | null;
  movementHistorySource?: string | null;
  marketPriceDisplayState?: MarketPriceDisplayState | null;
  recentMarketSignalUsd?: number | null;
  recentMarketSignalAsOf?: string | null;
  recentMarketSignalDeltaPct?: number | null;
  recentMarketSignalDirection?: "HIGHER" | "LOWER" | null;
  sourceMix?: {
    scrydexWeight: number;
    publicInputWeight?: number;
    jpNativeWeight?: number;
  };
  sampleCounts7d?: {
    scrydex: number;
    public?: number;
    jpNative?: number;
    total: number;
  };
};

function toFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toFiniteCount(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRawParityStatus(value: string | null | undefined, fallback: RawParityStatus): RawParityStatus {
  if (value === "MATCH" || value === "MISMATCH" || value === "MISSING_PROVIDER" || value === "UNKNOWN") return value;
  return fallback;
}

function isMarketBlendPolicy(value: string | null | undefined): value is MarketBlendPolicy {
  return value === "NO_PRICE"
    || value === "SCRYDEX_PRIMARY"
    || value === "YAHOO_JP_PRIMARY"
    || value === "SNKRDUNK_PRIMARY"
    || value === "POPALPHA_MARKET_CONFIDENT"
    || value === "POPALPHA_MARKET_SINGLE_SOURCE"
    || value === "POPALPHA_MARKET_CHEAP_DIVERGED_FLOOR"
    || value === "POPALPHA_MARKET_LOW_CONFIDENCE"
    || value === "POPALPHA_MARKET_QUARANTINED"
    || value === "NO_RELIABLE_PRICE"
    || value === "OUTLIER_SUPPRESSED";
}

function isMarketPriceDisplayState(value: string | null | undefined): value is MarketPriceDisplayState {
  return value === "ALIGNED"
    || value === "SIGNAL_HIGHER"
    || value === "SIGNAL_LOWER"
    || value === "PUBLIC_ONLY"
    || value === "PRICECHARTING_SINGLE_SOURCE"
    || value === "PRICECHARTING_CHEAP_DIVERGED"
    || value === "JP_LOW_SAMPLE"
    || value === "UNDER_REVIEW"
    || value === "NO_RELIABLE_PRICE";
}

function normalizeMarketPriceDisplayState(value: string | null | undefined): MarketPriceDisplayState | null {
  return isMarketPriceDisplayState(value) ? value : null;
}

function normalizeSignalDirection(value: string | null | undefined): "HIGHER" | "LOWER" | null {
  if (value === "HIGHER" || value === "LOWER") return value;
  return null;
}

function toFiniteOptionalNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareIsoDesc(left: string | null | undefined, right: string | null | undefined): number {
  const leftTs = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const rightTs = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return rightTs - leftTs;
}

function providerRank(provider: string | null | undefined): number {
  if (provider === "SCRYDEX") return 0;
  if (provider === "POKEMON_TCG_API") return 1;
  return 3;
}

function signalCompleteness(row: CanonicalVariantSignalRow): number {
  let total = 0;
  if (toFiniteNumber(row.provider_trend_slope_7d) !== null) total += 1;
  if (toFiniteNumber(row.provider_cov_price_30d) !== null) total += 1;
  if (toFiniteNumber(row.provider_price_relative_to_30d_range) !== null) total += 1;
  if ((toFiniteNumber(row.provider_price_changes_count_30d) ?? 0) > 0) total += 1;
  return total;
}

function chooseBestVariantSignalRow(rows: CanonicalVariantSignalRow[]): CanonicalVariantSignalRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((left, right) => {
    const leftEnoughHistory = (toFiniteNumber(left.history_points_30d) ?? 0) >= 10 ? 1 : 0;
    const rightEnoughHistory = (toFiniteNumber(right.history_points_30d) ?? 0) >= 10 ? 1 : 0;
    if (leftEnoughHistory !== rightEnoughHistory) return rightEnoughHistory - leftEnoughHistory;

    const completenessDelta = signalCompleteness(right) - signalCompleteness(left);
    if (completenessDelta !== 0) return completenessDelta;

    const providerDelta = providerRank(left.provider) - providerRank(right.provider);
    if (providerDelta !== 0) return providerDelta;

    const historyDelta = (toFiniteNumber(right.history_points_30d) ?? 0) - (toFiniteNumber(left.history_points_30d) ?? 0);
    if (historyDelta !== 0) return historyDelta;

    const providerAsOfDelta = compareIsoDesc(left.provider_as_of_ts, right.provider_as_of_ts);
    if (providerAsOfDelta !== 0) return providerAsOfDelta;

    const updatedAtDelta = compareIsoDesc(left.updated_at, right.updated_at);
    if (updatedAtDelta !== 0) return updatedAtDelta;

    return (toFiniteNumber(right.provider_price_changes_count_30d) ?? 0) - (toFiniteNumber(left.provider_price_changes_count_30d) ?? 0);
  })[0] ?? null;
}

function metricRowFromJpCoverage(
  baseRow: CanonicalMarketMetricRow | null,
  coverage: JpPriceCoverage,
): CanonicalMarketMetricRow {
  return {
    canonical_slug: coverage.canonicalSlug,
    scrydex_price: baseRow?.scrydex_price ?? baseRow?.market_price ?? coverage.marketPrice,
    pokemontcg_price: baseRow?.pokemontcg_price ?? null,
    market_price: baseRow?.market_price ?? coverage.marketPrice,
    market_price_as_of: baseRow?.market_price_as_of ?? coverage.marketPriceAsOf,
    liquidity_score: baseRow?.liquidity_score ?? null,
    active_listings_7d: baseRow?.active_listings_7d ?? coverage.activeListings7d,
    snapshot_count_30d: baseRow?.snapshot_count_30d ?? coverage.snapshotCount30d,
    median_7d: baseRow?.median_7d ?? null,
    provider_trend_slope_7d: baseRow?.provider_trend_slope_7d ?? null,
    provider_cov_price_30d: baseRow?.provider_cov_price_30d ?? null,
    provider_price_relative_to_30d_range: baseRow?.provider_price_relative_to_30d_range ?? null,
    provider_price_changes_count_30d: baseRow?.provider_price_changes_count_30d ?? null,
    market_confidence_score: baseRow?.market_confidence_score ?? coverage.marketConfidenceScore,
    market_low_confidence: baseRow?.market_low_confidence ?? coverage.marketLowConfidence,
    market_blend_policy: baseRow?.market_blend_policy ?? null,
    market_provenance: baseRow?.market_provenance ?? null,
    change_pct_24h: baseRow?.change_pct_24h ?? coverage.changePct24h,
    change_pct_7d: baseRow?.change_pct_7d ?? coverage.changePct7d,
    display_price_source: coverage.displayPriceSource,
    display_price_usd: coverage.displayPriceUsd,
    display_price_as_of: coverage.displayPriceAsOf,
    display_price_sample_count: coverage.displayPriceSampleCount,
    market_price_display_state: baseRow?.market_price_display_state ?? null,
    recent_market_signal_usd: baseRow?.recent_market_signal_usd ?? null,
    recent_market_signal_as_of: baseRow?.recent_market_signal_as_of ?? null,
    recent_market_signal_delta_pct: baseRow?.recent_market_signal_delta_pct ?? null,
    recent_market_signal_direction: baseRow?.recent_market_signal_direction ?? null,
  };
}

export function resolveCanonicalMarketPulse(
  row: Partial<Omit<CanonicalMarketMetricRow, "canonical_slug">> | null | undefined,
  parityStatus: RawParityStatus = "UNKNOWN",
  variantSignals: CanonicalVariantSignalRow | null = null,
): CanonicalMarketPulse {
  const provenance = row?.market_provenance ?? null;
  const displaySource = row?.display_price_source ?? null;
  const jpNativeSource = isJpNativeCoverageSource(displaySource);
  const displayPrice = toFiniteNumber(row?.display_price_usd);
  const rawMarketPrice = toFiniteNumber(row?.market_price);
  const marketPrice = displayPrice ?? rawMarketPrice;
  const trustedPriceSource = provenance?.trustedPriceSource ?? null;
  const trustStatus = provenance?.trustStatus ?? null;
  const confidenceStatus = provenance?.confidenceStatus ?? null;
  const publicInputStatus = provenance?.publicInputStatus ?? null;
  const movementHistorySource = provenance?.movementHistorySource ?? null;
  const rowDisplayState = normalizeMarketPriceDisplayState(row?.market_price_display_state ?? null);
  const provenanceDisplayState = normalizeMarketPriceDisplayState(provenance?.marketPriceDisplayState ?? null);
  const marketPriceDisplayState = marketPrice !== null
    ? (rowDisplayState ?? provenanceDisplayState ?? "ALIGNED")
    : "NO_RELIABLE_PRICE";
  const recentMarketSignalUsd = marketPrice !== null ? toFiniteNumber(row?.recent_market_signal_usd) : null;
  const recentMarketSignalAsOf = recentMarketSignalUsd !== null ? (row?.recent_market_signal_as_of ?? null) : null;
  const recentMarketSignalDeltaPct = recentMarketSignalUsd !== null
    ? (toFiniteNumber(row?.recent_market_signal_delta_pct) ?? toFiniteOptionalNumber(provenance?.recentMarketSignalDeltaPct))
    : null;
  const recentMarketSignalDirection = recentMarketSignalUsd !== null
    ? normalizeSignalDirection(row?.recent_market_signal_direction ?? provenance?.recentMarketSignalDirection ?? null)
    : null;
  const provenanceParityStatus = normalizeRawParityStatus(provenance?.parityStatus ?? null, parityStatus);
  const inferredPriceParityStatus: RawParityStatus | null =
    provenance?.priceConflictStatus === "CONSISTENT"
    && publicInputStatus === "SUPPORTED"
    && confidenceStatus === "HIGH"
      ? "MATCH"
      : null;
  const effectiveParityStatus = provenance?.parityStatus
    ? (provenanceParityStatus === "MISSING_PROVIDER" && inferredPriceParityStatus
        ? inferredPriceParityStatus
        : provenanceParityStatus)
    : inferredPriceParityStatus ?? parityStatus;
  const scrydexPrice = jpNativeSource ? rawMarketPrice : (toFiniteNumber(row?.scrydex_price) ?? rawMarketPrice);
  const sampleCounts7d = provenance?.sampleCounts7d;
  const scrydexPoints7d = rawMarketPrice !== null
    ? Math.max(0, toFiniteCount(sampleCounts7d?.scrydex) ?? 0)
    : 0;
  const explicitPublicPoints7d = toFiniteCount(sampleCounts7d?.public);
  const publicPoints7d = rawMarketPrice !== null
    ? Math.max(0, explicitPublicPoints7d ?? toFiniteCount(sampleCounts7d?.scrydex) ?? 0)
    : 0;
  const jpNativeSampleCount = jpNativeSource
    ? Math.max(0, Math.floor(toFiniteNumber(row?.display_price_sample_count) ?? 0))
    : 0;
  const change24h = marketPrice !== null ? toFiniteNumber(row?.change_pct_24h) : null;
  const change7d = marketPrice !== null ? toFiniteNumber(row?.change_pct_7d) : null;
  const confidenceScore = marketPrice !== null
    ? (jpNativeSource ? computeJpNativeConfidence(jpNativeSampleCount) : toFiniteNumber(row?.market_confidence_score) ?? undefined)
    : undefined;
  const lowConfidence = marketPrice === null
    ? true
    : jpNativeSource
      ? jpNativeSampleCount < 5
      : (typeof row?.market_low_confidence === "boolean" ? row.market_low_confidence : false);
  const activeListings7d = marketPrice !== null
    ? (jpNativeSource ? jpNativeSampleCount : toFiniteNumber(row?.active_listings_7d))
    : null;
  const snapshotCount30d = marketPrice !== null
    ? (jpNativeSource ? jpNativeSampleCount : toFiniteNumber(row?.snapshot_count_30d))
    : null;
  const marketStrength = computeCanonicalMarketStrength({
    trendSlope7d: row?.provider_trend_slope_7d ?? variantSignals?.provider_trend_slope_7d,
    covPrice30d: row?.provider_cov_price_30d ?? variantSignals?.provider_cov_price_30d,
    priceRelativeTo30dRange: row?.provider_price_relative_to_30d_range ?? variantSignals?.provider_price_relative_to_30d_range,
    priceChangesCount30d: row?.provider_price_changes_count_30d ?? variantSignals?.provider_price_changes_count_30d,
    latestPrice: marketPrice,
    snapshotCount30d: snapshotCount30d ?? variantSignals?.history_points_30d,
    confidenceScore,
    lowConfidence,
    liquidityScore: row?.liquidity_score,
    activeListings7d,
    changePct24h: change24h,
    changePct7d: change7d,
  });
  const blendPolicy = marketPrice === null
    ? "NO_PRICE"
    : isMarketBlendPolicy(row?.market_blend_policy)
      ? row.market_blend_policy
      : displaySource === "yahoo_jp"
      ? "YAHOO_JP_PRIMARY"
      : displaySource === "snkrdunk"
        ? "SNKRDUNK_PRIMARY"
        : "SCRYDEX_PRIMARY";
  const provenanceSourceMix = provenance?.sourceMix;

  // Freshest hero price for the homepage card price (so it matches the detail
  // hero). EN: prefer the view's guarded latest_price, fall back to the median.
  // JP-native: the picked source price is already the freshest observation, and
  // the view's latest_price column isn't JP-aware — so use marketPrice directly.
  const latestPrice = marketPrice === null
    ? null
    : jpNativeSource
      ? marketPrice
      : (toFiniteNumber(row?.latest_price) ?? marketPrice);
  const latestPriceAsOf = latestPrice === null
    ? null
    : jpNativeSource
      ? (row?.display_price_as_of ?? row?.market_price_as_of ?? null)
      : (row?.latest_price_as_of ?? row?.display_price_as_of ?? row?.market_price_as_of ?? null);

  const basePayload = {
    scrydexPrice,
    pokemontcgPrice: null,
    marketPrice,
    marketPriceAsOf: marketPrice !== null ? (row?.display_price_as_of ?? row?.market_price_as_of ?? null) : null,
    latestPrice,
    latestPriceAsOf,
    liquidityScore: marketPrice !== null && !jpNativeSource ? toFiniteNumber(row?.liquidity_score) : null,
    activeListings7d,
    snapshotCount30d,
    changePct24h: change24h,
    changePct7d: change7d,
    parityStatus: effectiveParityStatus,
    blendPolicy,
    confidenceScore,
    lowConfidence,
    marketStrengthScore: marketStrength.marketStrengthScore,
    marketDirection: marketStrength.marketDirection,
    priceSource: displaySource ?? (marketPrice !== null ? "market" : null),
    trustedPriceSource,
    trustStatus,
    confidenceStatus,
    publicInputStatus,
    movementHistorySource,
    marketPriceDisplayState,
    recentMarketSignalUsd,
    recentMarketSignalAsOf,
    recentMarketSignalDeltaPct,
    recentMarketSignalDirection,
    sourceMix: {
      // Read the Scrydex weight from the provenance's OWN scrydexWeight, not
      // publicInputWeight. They diverge for rows with a public price but no
      // Scrydex corroboration — single-source PriceCharting and the cheap
      // diverged floor (scrydexWeight 0, publicInputWeight 1). Mapping from
      // publicInputWeight reported those as Scrydex-backed (weight 1).
      scrydexWeight: marketPrice !== null && !jpNativeSource
        ? (provenanceSourceMix?.scrydexWeight ?? 1)
        : 0,
      ...(provenanceSourceMix?.publicInputWeight !== undefined
        ? { publicInputWeight: provenanceSourceMix.publicInputWeight }
        : {}),
      ...(jpNativeSource ? { jpNativeWeight: 1 } : {}),
    },
    sampleCounts7d: {
      scrydex: scrydexPoints7d,
      ...(explicitPublicPoints7d !== null && publicPoints7d > 0 ? { public: publicPoints7d } : {}),
      ...(jpNativeSource ? { jpNative: jpNativeSampleCount } : {}),
      total: jpNativeSource ? jpNativeSampleCount : Math.max(scrydexPoints7d, publicPoints7d),
    },
  } satisfies Omit<CanonicalMarketPulse, "changePct" | "changeWindow">;

  if (change24h !== null) {
    return {
      ...basePayload,
      changePct: change24h,
      changeWindow: "24H",
    };
  }

  if (change7d !== null) {
    return {
      ...basePayload,
      changePct: change7d,
      changeWindow: "7D",
    };
  }

  return {
    ...basePayload,
    changePct: null,
    changeWindow: null,
  };
}

export async function getCanonicalMarketPulseMap(
  supabase: SupabaseClient,
  slugs: string[],
  options: { includeJpPriceCoverage?: boolean } = {},
): Promise<Map<string, CanonicalMarketPulse>> {
  const pulseMap = new Map<string, CanonicalMarketPulse>();
  if (slugs.length === 0) return pulseMap;

  const [
    metricsResult,
    parityResult,
    variantSignalResult,
    jpCoverageResult,
  ] = await Promise.all([
    supabase
      .from("public_card_metrics")
      .select("canonical_slug, scrydex_price, pokemontcg_price, market_price, market_price_as_of, latest_price, latest_price_as_of, liquidity_score, active_listings_7d, snapshot_count_30d, median_7d, provider_trend_slope_7d, provider_cov_price_30d, provider_price_relative_to_30d_range, provider_price_changes_count_30d, market_confidence_score, market_low_confidence, market_blend_policy, market_provenance, change_pct_24h, change_pct_7d, market_price_display_state, recent_market_signal_usd, recent_market_signal_as_of, recent_market_signal_delta_pct, recent_market_signal_direction")
      .in("canonical_slug", slugs)
      .is("printing_id", null)
      .eq("grade", "RAW")
      .order("updated_at", { ascending: false }),
    supabase
      .from("canonical_raw_provider_parity")
      .select("canonical_slug, parity_status")
      .in("canonical_slug", slugs),
    supabase
      .from("public_variant_metrics")
      .select("canonical_slug, provider, provider_trend_slope_7d, provider_cov_price_30d, provider_price_relative_to_30d_range, provider_price_changes_count_30d, history_points_30d, provider_as_of_ts, updated_at")
      .in("canonical_slug", slugs)
      .eq("grade", "RAW")
      .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
      .order("updated_at", { ascending: false }),
    options.includeJpPriceCoverage
      ? loadJpPriceCoverageMap(supabase, slugs)
          .then((data) => ({ data, error: null as Error | null }))
          .catch((error: unknown) => ({
            data: new Map<string, JpPriceCoverage>(),
            error: error instanceof Error ? error : new Error(String(error)),
          }))
      : Promise.resolve({
          data: new Map<string, JpPriceCoverage>(),
          error: null as Error | null,
        }),
  ]);

  const { data, error } = metricsResult;
  const { data: parityData, error: parityError } = parityResult;
  const { data: variantSignalData, error: variantSignalError } = variantSignalResult;
  const { data: jpCoverageBySlug, error: jpCoverageError } = jpCoverageResult;

  if (error) {
    console.error("[getCanonicalMarketPulseMap]", error.message);
    return pulseMap;
  }
  if (parityError) {
    console.error("[getCanonicalMarketPulseMap:parity]", parityError.message);
  }
  if (variantSignalError) {
    console.error("[getCanonicalMarketPulseMap:variant_signals]", variantSignalError.message);
  }
  if (jpCoverageError) {
    console.error("[getCanonicalMarketPulseMap:jp_price_coverage]", jpCoverageError.message);
  }

  const metricRowsBySlug = new Map<string, CanonicalMarketMetricRow>();
  for (const row of (data ?? []) as CanonicalMarketMetricRow[]) {
    if (!metricRowsBySlug.has(row.canonical_slug)) {
      metricRowsBySlug.set(row.canonical_slug, row);
    }
  }

  const parityBySlug = new Map<string, CanonicalParityRow["parity_status"]>();
  for (const row of (parityData ?? []) as CanonicalParityRow[]) {
    parityBySlug.set(row.canonical_slug, row.parity_status);
  }

  const variantSignalRowsBySlug = new Map<string, CanonicalVariantSignalRow[]>();
  for (const row of (variantSignalData ?? []) as CanonicalVariantSignalRow[]) {
    const current = variantSignalRowsBySlug.get(row.canonical_slug) ?? [];
    current.push(row);
    variantSignalRowsBySlug.set(row.canonical_slug, current);
  }

  const bestVariantSignalsBySlug = new Map<string, CanonicalVariantSignalRow>();
  for (const [slug, rows] of variantSignalRowsBySlug.entries()) {
    const bestRow = chooseBestVariantSignalRow(rows);
    if (bestRow) bestVariantSignalsBySlug.set(slug, bestRow);
  }

  for (const slug of slugs) {
    if (pulseMap.has(slug)) continue;
    const metricRow = metricRowsBySlug.get(slug) ?? null;
    const jpCoverage = jpCoverageBySlug.get(slug) ?? null;
    const row = jpCoverage ? metricRowFromJpCoverage(metricRow, jpCoverage) : metricRow;
    if (!row) continue;
    const resolved = resolveCanonicalMarketPulse(
      row,
      parityBySlug.get(row.canonical_slug) ?? "UNKNOWN",
      bestVariantSignalsBySlug.get(row.canonical_slug) ?? null,
    );
    const jpNativeSource = isJpNativeCoverageSource(row.display_price_source);
    if (!jpNativeSource && row.market_confidence_score !== null && row.market_confidence_score !== undefined) {
      resolved.confidenceScore = Math.round(row.market_confidence_score);
    }
    if (!jpNativeSource && typeof row.market_low_confidence === "boolean") {
      resolved.lowConfidence = row.market_low_confidence;
    }
    pulseMap.set(row.canonical_slug, resolved);
  }

  return pulseMap;
}
