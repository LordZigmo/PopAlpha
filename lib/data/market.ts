import type { SupabaseClient } from "@supabase/supabase-js";

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

export type CanonicalMarketPulse = {
  justtcgPrice: number | null;
  scrydexPrice: number | null;
  pokemontcgPrice: number | null;
  marketPrice: number | null;
  changePct: number | null;
  changeWindow: MarketChangeWindow | null;
};

function toFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveRawMarketPrice(params: {
  justtcgPrice: number | null;
  scrydexPrice: number | null;
  marketPrice: number | null;
  median7d: number | null;
}): number | null {
  const { justtcgPrice, scrydexPrice, marketPrice, median7d } = params;
  if (justtcgPrice !== null && scrydexPrice !== null) {
    const high = Math.max(justtcgPrice, scrydexPrice);
    const low = Math.min(justtcgPrice, scrydexPrice);
    // If providers are far apart, prefer JustTCG to avoid transient outliers.
    if (low > 0 && high / low >= 3.5) return justtcgPrice;
    return Number((((justtcgPrice + scrydexPrice) / 2)).toFixed(4));
  }
  if (justtcgPrice !== null) return justtcgPrice;
  if (scrydexPrice !== null) return scrydexPrice;
  return marketPrice ?? median7d;
}

export function resolveCanonicalMarketPulse(
  row: Partial<Omit<CanonicalMarketMetricRow, "canonical_slug">> | null | undefined,
): CanonicalMarketPulse {
  const justtcgPrice = toFiniteNumber(row?.justtcg_price);
  const scrydexPrice = toFiniteNumber(row?.scrydex_price) ?? toFiniteNumber(row?.pokemontcg_price);
  const marketPrice = resolveRawMarketPrice({
    justtcgPrice,
    scrydexPrice,
    marketPrice: toFiniteNumber(row?.market_price),
    median7d: toFiniteNumber(row?.median_7d),
  });
  const change24h = toFiniteNumber(row?.change_pct_24h);

  if (change24h !== null) {
    return {
      justtcgPrice,
      scrydexPrice,
      pokemontcgPrice: scrydexPrice,
      marketPrice,
      changePct: change24h,
      changeWindow: "24H",
    };
  }

  const change7d = toFiniteNumber(row?.change_pct_7d);
  if (change7d !== null) {
    return {
      justtcgPrice,
      scrydexPrice,
      pokemontcgPrice: scrydexPrice,
      marketPrice,
      changePct: change7d,
      changeWindow: "7D",
    };
  }

  return {
    justtcgPrice,
    scrydexPrice,
    pokemontcgPrice: scrydexPrice,
    marketPrice,
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

  if (error) {
    console.error("[getCanonicalMarketPulseMap]", error.message);
    return pulseMap;
  }

  for (const row of (data ?? []) as CanonicalMarketMetricRow[]) {
    if (pulseMap.has(row.canonical_slug)) continue;
    pulseMap.set(row.canonical_slug, resolveCanonicalMarketPulse(row));
  }

  return pulseMap;
}
