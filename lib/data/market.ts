import type { SupabaseClient } from "@supabase/supabase-js";

export type MarketChangeWindow = "24H" | "7D";

type CanonicalMarketMetricRow = {
  canonical_slug: string;
  market_price: number | null;
  median_7d: number | null;
  change_pct_24h: number | null;
  change_pct_7d: number | null;
};

export type CanonicalMarketPulse = {
  marketPrice: number | null;
  changePct: number | null;
  changeWindow: MarketChangeWindow | null;
};

function toFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveCanonicalMarketPulse(
  row: Partial<Omit<CanonicalMarketMetricRow, "canonical_slug">> | null | undefined,
): CanonicalMarketPulse {
  const marketPrice = toFiniteNumber(row?.market_price) ?? toFiniteNumber(row?.median_7d);
  const change24h = toFiniteNumber(row?.change_pct_24h);

  if (change24h !== null) {
    return { marketPrice, changePct: change24h, changeWindow: "24H" };
  }

  const change7d = toFiniteNumber(row?.change_pct_7d);
  if (change7d !== null) {
    return { marketPrice, changePct: change7d, changeWindow: "7D" };
  }

  return { marketPrice, changePct: null, changeWindow: null };
}

export async function getCanonicalMarketPulseMap(
  supabase: SupabaseClient,
  slugs: string[],
): Promise<Map<string, CanonicalMarketPulse>> {
  const pulseMap = new Map<string, CanonicalMarketPulse>();
  if (slugs.length === 0) return pulseMap;

  const { data, error } = await supabase
    .from("public_card_metrics")
    .select("canonical_slug, market_price, median_7d, change_pct_24h, change_pct_7d")
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
