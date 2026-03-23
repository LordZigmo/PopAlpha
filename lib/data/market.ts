import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type RawParityStatus,
} from "@/lib/pricing/market-confidence";
import {
  computeCanonicalMarketStrength,
  type MarketDirection,
} from "@/lib/data/market-strength";

export type MarketChangeWindow = "24H" | "7D";

type CanonicalMarketMetricRow = {
  canonical_slug: string;
  justtcg_price: number | null;
  scrydex_price: number | null;
  pokemontcg_price?: number | null;
  market_price: number | null;
  market_price_as_of?: string | null;
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
  market_blend_policy?: "NO_PRICE" | "SCRYDEX_PRIMARY" | null;
  market_provenance?: {
    sourceMix?: {
      justtcgWeight?: number;
      scrydexWeight?: number;
    };
  } | null;
  change_pct_24h: number | null;
  change_pct_7d: number | null;
};

type CanonicalParityRow = {
  canonical_slug: string;
  parity_status: "MATCH" | "MISMATCH" | "MISSING_PROVIDER" | "UNKNOWN";
};

export type CanonicalMarketPulse = {
  justtcgPrice: number | null;
  scrydexPrice: number | null;
  pokemontcgPrice: number | null;
  marketPrice: number | null;
  marketPriceAsOf?: string | null;
  liquidityScore?: number | null;
  activeListings7d?: number | null;
  snapshotCount30d?: number | null;
  changePct24h: number | null;
  changePct7d: number | null;
  changePct: number | null;
  changeWindow: MarketChangeWindow | null;
  parityStatus: RawParityStatus;
  blendPolicy?: "NO_PRICE" | "SCRYDEX_PRIMARY";
  confidenceScore?: number;
  lowConfidence?: boolean;
  marketStrengthScore?: number | null;
  marketDirection?: MarketDirection | null;
  sourceMix?: {
    justtcgWeight: number;
    scrydexWeight: number;
  };
  sampleCounts7d?: {
    justtcg: number;
    scrydex: number;
    total: number;
  };
};

function toFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveCanonicalMarketPulse(
  row: Partial<Omit<CanonicalMarketMetricRow, "canonical_slug">> | null | undefined,
  parityStatus: RawParityStatus = "UNKNOWN",
): CanonicalMarketPulse {
  const marketPrice = toFiniteNumber(row?.market_price);
  const scrydexPrice = marketPrice;
  const scrydexOnlySampleCounts = (row?.market_provenance as {
    sampleCounts7d?: { scrydex?: number };
  } | null)?.sampleCounts7d;
  const scrydexPoints7d = marketPrice !== null
    ? Math.max(0, toFiniteNumber(scrydexOnlySampleCounts?.scrydex) ?? 0)
    : 0;
  const change24h = marketPrice !== null ? toFiniteNumber(row?.change_pct_24h) : null;
  const change7d = marketPrice !== null ? toFiniteNumber(row?.change_pct_7d) : null;
  const confidenceScore = marketPrice !== null
    ? (toFiniteNumber(row?.market_confidence_score) ?? undefined)
    : undefined;
  const lowConfidence = marketPrice === null
    ? true
    : (typeof row?.market_low_confidence === "boolean" ? row.market_low_confidence : false);
  const marketStrength = computeCanonicalMarketStrength({
    trendSlope7d: row?.provider_trend_slope_7d,
    covPrice30d: row?.provider_cov_price_30d,
    priceRelativeTo30dRange: row?.provider_price_relative_to_30d_range,
    priceChangesCount30d: row?.provider_price_changes_count_30d,
    latestPrice: marketPrice,
    snapshotCount30d: row?.snapshot_count_30d,
    confidenceScore,
    lowConfidence,
    liquidityScore: row?.liquidity_score,
    activeListings7d: row?.active_listings_7d,
    changePct24h: change24h,
    changePct7d: change7d,
  });

  const basePayload = {
    justtcgPrice: null,
    scrydexPrice,
    pokemontcgPrice: null,
    marketPrice,
    marketPriceAsOf: marketPrice !== null ? row?.market_price_as_of ?? null : null,
    liquidityScore: marketPrice !== null ? toFiniteNumber(row?.liquidity_score) : null,
    activeListings7d: marketPrice !== null ? toFiniteNumber(row?.active_listings_7d) : null,
    snapshotCount30d: marketPrice !== null ? toFiniteNumber(row?.snapshot_count_30d) : null,
    changePct24h: change24h,
    changePct7d: change7d,
    parityStatus,
    blendPolicy: marketPrice !== null ? "SCRYDEX_PRIMARY" : "NO_PRICE",
    confidenceScore,
    lowConfidence,
    marketStrengthScore: marketStrength.marketStrengthScore,
    marketDirection: marketStrength.marketDirection,
    sourceMix: {
      justtcgWeight: 0,
      scrydexWeight: marketPrice !== null ? 1 : 0,
    },
    sampleCounts7d: {
      justtcg: 0,
      scrydex: scrydexPoints7d,
      total: scrydexPoints7d,
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
): Promise<Map<string, CanonicalMarketPulse>> {
  const pulseMap = new Map<string, CanonicalMarketPulse>();
  if (slugs.length === 0) return pulseMap;

  const { data, error } = await supabase
    .from("public_card_metrics")
    .select("canonical_slug, justtcg_price, scrydex_price, pokemontcg_price, market_price, market_price_as_of, liquidity_score, active_listings_7d, snapshot_count_30d, median_7d, provider_trend_slope_7d, provider_cov_price_30d, provider_price_relative_to_30d_range, provider_price_changes_count_30d, market_confidence_score, market_low_confidence, market_blend_policy, market_provenance, change_pct_24h, change_pct_7d")
    .in("canonical_slug", slugs)
    .is("printing_id", null)
    .eq("grade", "RAW")
    .order("updated_at", { ascending: false });

  const { data: parityData, error: parityError } = await supabase
    .from("canonical_raw_provider_parity")
    .select("canonical_slug, parity_status")
    .in("canonical_slug", slugs);

  if (error) {
    console.error("[getCanonicalMarketPulseMap]", error.message);
    return pulseMap;
  }
  if (parityError) {
    console.error("[getCanonicalMarketPulseMap:parity]", parityError.message);
  }

  const parityBySlug = new Map<string, CanonicalParityRow["parity_status"]>();
  for (const row of (parityData ?? []) as CanonicalParityRow[]) {
    parityBySlug.set(row.canonical_slug, row.parity_status);
  }

  for (const row of (data ?? []) as CanonicalMarketMetricRow[]) {
    if (pulseMap.has(row.canonical_slug)) continue;
    const resolved = resolveCanonicalMarketPulse(
      row,
      parityBySlug.get(row.canonical_slug) ?? "UNKNOWN",
    );
    if (row.market_confidence_score !== null && row.market_confidence_score !== undefined) {
      resolved.confidenceScore = Math.round(row.market_confidence_score);
    }
    if (typeof row.market_low_confidence === "boolean") {
      resolved.lowConfidence = row.market_low_confidence;
    }
    pulseMap.set(row.canonical_slug, resolved);
  }

  return pulseMap;
}
