import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrencyToUsdRateAt } from "@/lib/pricing/fx";

export type ProviderName = "JUSTTCG" | "SCRYDEX";

export type ProviderPriceDisplay = {
  provider: ProviderName;
  sourcePrice: number | null;
  sourceCurrency: string | null;
  usdPrice: number | null;
  fxRateUsed: number | null;
  fxSource: "FX_RATES_TABLE" | "ENV_EUR_TO_USD_RATE" | "ENV_JPY_TO_USD_RATE" | "IDENTITY" | "UNKNOWN";
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
  } else if (sourceCurrency === "EUR" || sourceCurrency === "JPY") {
    const fx = await getCurrencyToUsdRateAt({
      supabase: params.supabase,
      currency: sourceCurrency,
      asOf: params.asOf,
    });
    fxRateUsed = fx.rate;
    fxSource = fx.fxSource;
    fxAsOf = fx.fxAsOf;
  }

  const usdPrice = sourcePrice !== null && (sourceCurrency === "EUR" || sourceCurrency === "JPY") && fxRateUsed
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
  const justtcg = rows.find((row) => row.provider === "JUSTTCG")?.usdPrice ?? null;
  const scrydex = rows.find((row) => row.provider === "SCRYDEX")?.usdPrice ?? null;
  if (typeof scrydex === "number" && Number.isFinite(scrydex) && scrydex > 0) return scrydex;
  if (typeof justtcg === "number" && Number.isFinite(justtcg) && justtcg > 0) return justtcg;
  return null;
}
