import type { SupabaseClient } from "@supabase/supabase-js";
import { getEurToUsdRateAt } from "@/lib/pricing/fx";

export type ProviderName = "JUSTTCG" | "SCRYDEX";

export type ProviderPriceDisplay = {
  provider: ProviderName;
  sourcePrice: number | null;
  sourceCurrency: string | null;
  usdPrice: number | null;
  fxRateUsed: number | null;
  fxSource: "FX_RATES_TABLE" | "ENV_EUR_TO_USD_RATE" | "IDENTITY" | "UNKNOWN";
  fxAsOf: string | null;
  asOf: string | null;
};

function toFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedCurrency(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || null;
}

export async function buildProviderPriceDisplay(params: {
  supabase: SupabaseClient;
  provider: ProviderName;
  sourcePrice: number | null | undefined;
  sourceCurrency: string | null | undefined;
  asOf: string | null | undefined;
}): Promise<ProviderPriceDisplay> {
  const sourcePrice = toFinite(params.sourcePrice);
  const sourceCurrency = normalizedCurrency(params.sourceCurrency);
  let fxRateUsed: number | null = null;
  let fxSource: ProviderPriceDisplay["fxSource"] = "UNKNOWN";
  let fxAsOf: string | null = null;

  if (sourceCurrency === "USD") {
    fxRateUsed = 1;
    fxSource = "IDENTITY";
  } else if (sourceCurrency === "EUR") {
    const fx = await getEurToUsdRateAt({
      supabase: params.supabase,
      asOf: params.asOf,
    });
    fxRateUsed = fx.rate;
    fxSource = fx.fxSource;
    fxAsOf = fx.fxAsOf;
  }

  const usdPrice = sourcePrice !== null && sourceCurrency === "EUR" && fxRateUsed
    ? Number((sourcePrice * fxRateUsed).toFixed(4))
    : sourcePrice !== null && sourceCurrency === "USD"
      ? sourcePrice
      : null;

  return {
    provider: params.provider,
    sourcePrice,
    sourceCurrency,
    usdPrice,
    fxRateUsed,
    fxSource,
    fxAsOf,
    asOf: params.asOf ?? null,
  };
}

export function averageProviderUsdPrice(rows: ProviderPriceDisplay[]): number | null {
  const cleanRows = rows
    .map((row) => ({
      provider: row.provider,
      price: row.usdPrice,
    }))
    .filter((row): row is { provider: ProviderName; price: number } => typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0);
  if (cleanRows.length === 0) return null;
  if (cleanRows.length === 1) return cleanRows[0].price;

  const justtcg = cleanRows.find((row) => row.provider === "JUSTTCG")?.price ?? null;
  const scrydex = cleanRows.find((row) => row.provider === "SCRYDEX")?.price ?? null;

  // Guard against one provider drifting wildly and poisoning the blended RAW market price.
  if (justtcg !== null && scrydex !== null) {
    const high = Math.max(justtcg, scrydex);
    const low = Math.min(justtcg, scrydex);
    if (low > 0 && high / low >= 3.5) {
      return justtcg;
    }
  }

  const total = cleanRows.reduce((sum, row) => sum + row.price, 0);
  return Number((total / cleanRows.length).toFixed(4));
}
