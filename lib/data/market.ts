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
  median_7d: number | null;
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
    .select("canonical_slug, justtcg_price, scrydex_price, pokemontcg_price, market_price, median_7d, change_pct_24h, change_pct_7d")
    .in("canonical_slug", slugs)
    .is("printing_id", null)
    .eq("grade", "RAW")
    .order("updated_at", { ascending: false });

  const { data: parityData, error: parityError } = await supabase
    .from("canonical_raw_provider_parity")
    .select("canonical_slug, parity_status")
    .in("canonical_slug", slugs);

  const [providerMetricsRes, providerCountsRes] = await Promise.all([
    supabase
      .from("public_variant_metrics")
      .select("canonical_slug, provider, provider_as_of_ts")
      .in("canonical_slug", slugs)
      .eq("grade", "RAW")
      .is("printing_id", null)
      .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
      .limit(Math.max(200, slugs.length * 8)),
    supabase
      .from("public_price_history")
      .select("canonical_slug, provider, ts")
      .in("canonical_slug", slugs)
      .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
      .eq("source_window", "snapshot")
      .gte("ts", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order("ts", { ascending: false })
      .limit(Math.max(1000, slugs.length * 40)),
  ]);

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

  const providerAsOf = new Map<string, { justtcgAsOf: string | null; scrydexAsOf: string | null }>();
  for (const row of (providerMetricsRes.data ?? []) as Array<{
    canonical_slug: string;
    provider: string;
    provider_as_of_ts: string | null;
  }>) {
    const slug = row.canonical_slug;
    const bucket = providerAsOf.get(slug) ?? { justtcgAsOf: null, scrydexAsOf: null };
    if (row.provider === "JUSTTCG" && row.provider_as_of_ts && (!bucket.justtcgAsOf || row.provider_as_of_ts > bucket.justtcgAsOf)) {
      bucket.justtcgAsOf = row.provider_as_of_ts;
    }
    if ((row.provider === "SCRYDEX" || row.provider === "POKEMON_TCG_API") && row.provider_as_of_ts && (!bucket.scrydexAsOf || row.provider_as_of_ts > bucket.scrydexAsOf)) {
      bucket.scrydexAsOf = row.provider_as_of_ts;
    }
    providerAsOf.set(slug, bucket);
  }

  const providerPoints = new Map<string, { justtcg: number; scrydex: number }>();
  for (const row of (providerCountsRes.data ?? []) as Array<{ canonical_slug: string; provider: string }>) {
    const slug = row.canonical_slug;
    const bucket = providerPoints.get(slug) ?? { justtcg: 0, scrydex: 0 };
    if (row.provider === "JUSTTCG") bucket.justtcg += 1;
    if (row.provider === "SCRYDEX" || row.provider === "POKEMON_TCG_API") bucket.scrydex += 1;
    providerPoints.set(slug, bucket);
  }

  for (const row of (data ?? []) as CanonicalMarketMetricRow[]) {
    if (pulseMap.has(row.canonical_slug)) continue;
    const asOf = providerAsOf.get(row.canonical_slug) ?? { justtcgAsOf: null, scrydexAsOf: null };
    const points = providerPoints.get(row.canonical_slug) ?? { justtcg: 0, scrydex: 0 };
    pulseMap.set(
      row.canonical_slug,
      resolveCanonicalMarketPulse(
        row,
        parityBySlug.get(row.canonical_slug) ?? "UNKNOWN",
        [
          { provider: "JUSTTCG", price: toFiniteNumber(row.justtcg_price), asOfTs: asOf.justtcgAsOf, points7d: points.justtcg },
          { provider: "SCRYDEX", price: toFiniteNumber(row.scrydex_price ?? row.pokemontcg_price), asOfTs: asOf.scrydexAsOf, points7d: points.scrydex },
        ],
      ),
    );
  }

  return pulseMap;
}
