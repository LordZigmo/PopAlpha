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
  const prices = rows
    .map((row) => row.usdPrice)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (prices.length === 0) return null;
  const total = prices.reduce((sum, value) => sum + value, 0);
  return Number((total / prices.length).toFixed(4));
}
