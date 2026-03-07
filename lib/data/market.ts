import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveWeightedMarketPrice,
  type ProviderInput,
  type RawParityStatus,
} from "@/lib/pricing/market-confidence";

export type MarketChangeWindow = "24H" | "7D";

type CanonicalMarketMetricRow = {
  canonical_slug: string;
  justtcg_price: number | null;
  scrydex_price: number | null;
  pokemontcg_price?: number | null;
  market_price: number | null;
  market_price_as_of?: string | null;
  active_listings_7d?: number | null;
  snapshot_count_30d?: number | null;
  median_7d: number | null;
  market_confidence_score?: number | null;
  market_low_confidence?: boolean | null;
  market_blend_policy?: "NO_PRICE" | "SINGLE_PROVIDER" | "TRUST_WEIGHTED_BLEND" | "FALLBACK_STALE_OR_OUTLIER" | null;
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
  activeListings7d?: number | null;
  snapshotCount30d?: number | null;
  changePct: number | null;
  changeWindow: MarketChangeWindow | null;
  parityStatus: RawParityStatus;
  blendPolicy?: "NO_PRICE" | "SINGLE_PROVIDER" | "TRUST_WEIGHTED_BLEND" | "FALLBACK_STALE_OR_OUTLIER";
  confidenceScore?: number;
  lowConfidence?: boolean;
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
  providerInputs: ProviderInput[] = [],
): CanonicalMarketPulse {
  const justtcgPrice = toFiniteNumber(row?.justtcg_price);
  const scrydexPrice = toFiniteNumber(row?.scrydex_price) ?? toFiniteNumber(row?.pokemontcg_price);
  const weighted = resolveWeightedMarketPrice({
    providers: providerInputs.length > 0
      ? providerInputs
      : [
        { provider: "JUSTTCG", price: justtcgPrice },
        { provider: "SCRYDEX", price: scrydexPrice },
      ],
    parityStatus,
    marketPriceFallback: toFiniteNumber(row?.market_price),
    median7dFallback: toFiniteNumber(row?.median_7d),
  });
  const marketPrice = weighted.marketPrice;

  const basePayload = {
    justtcgPrice,
    scrydexPrice,
    pokemontcgPrice: scrydexPrice,
    marketPrice,
    marketPriceAsOf: row?.market_price_as_of ?? null,
    activeListings7d: toFiniteNumber(row?.active_listings_7d),
    snapshotCount30d: toFiniteNumber(row?.snapshot_count_30d),
    parityStatus,
    blendPolicy: weighted.blendPolicy,
    confidenceScore: weighted.confidenceScore,
    lowConfidence: weighted.lowConfidence,
    sourceMix: weighted.sourceMix,
  } satisfies Omit<CanonicalMarketPulse, "changePct" | "changeWindow">;

  const change24h = toFiniteNumber(row?.change_pct_24h);
  if (change24h !== null) {
    return {
      ...basePayload,
      changePct: change24h,
      changeWindow: "24H",
    };
  }

  const change7d = toFiniteNumber(row?.change_pct_7d);
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
    .select("canonical_slug, justtcg_price, scrydex_price, pokemontcg_price, market_price, market_price_as_of, active_listings_7d, snapshot_count_30d, median_7d, market_confidence_score, market_low_confidence, market_blend_policy, market_provenance, change_pct_24h, change_pct_7d")
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
    if (row.market_blend_policy) {
      resolved.blendPolicy = row.market_blend_policy;
    }
    const sourceMix = row.market_provenance?.sourceMix;
    const sampleCounts7d = (row.market_provenance as {
      sampleCounts7d?: { justtcg?: number; scrydex?: number };
    } | null)?.sampleCounts7d;
    if (
      sourceMix &&
      typeof sourceMix.justtcgWeight === "number" &&
      typeof sourceMix.scrydexWeight === "number"
    ) {
      resolved.sourceMix = {
        justtcgWeight: sourceMix.justtcgWeight,
        scrydexWeight: sourceMix.scrydexWeight,
      };
    }
    if (
      sampleCounts7d &&
      typeof sampleCounts7d.justtcg === "number" &&
      typeof sampleCounts7d.scrydex === "number"
    ) {
      resolved.sampleCounts7d = {
        justtcg: Math.max(0, sampleCounts7d.justtcg),
        scrydex: Math.max(0, sampleCounts7d.scrydex),
        total: Math.max(0, sampleCounts7d.justtcg + sampleCounts7d.scrydex),
      };
    }
    pulseMap.set(row.canonical_slug, resolved);
  }

  return pulseMap;
}
