import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_EUR_TO_USD_RATE = 1.08;

function parsePositiveRate(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function getEurToUsdRate(): number {
  return parsePositiveRate(process.env.EUR_TO_USD_RATE) ?? DEFAULT_EUR_TO_USD_RATE;
}

export function convertToUsd(value: number, currency: string): number {
  if (!Number.isFinite(value) || value <= 0) return value;
  const normalizedCurrency = String(currency).trim().toUpperCase();
  if (normalizedCurrency === "USD") return value;
  if (normalizedCurrency === "EUR") {
    const rate = getEurToUsdRate();
    return Number((value * rate).toFixed(4));
  }
  return value;
}

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export async function getEurToUsdRateAt(params: {
  supabase: SupabaseClient;
  asOf: string | null | undefined;
}): Promise<{
  rate: number;
  fxAsOf: string | null;
  fxSource: "FX_RATES_TABLE" | "ENV_EUR_TO_USD_RATE";
}> {
  const asOfDate = toIsoDate(params.asOf) ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await params.supabase
    .from("fx_rates")
    .select("rate, rate_date")
    .eq("pair", "EURUSD")
    .lte("rate_date", asOfDate)
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle<{ rate: number; rate_date: string }>();

  if (!error && data && typeof data.rate === "number" && Number.isFinite(data.rate) && data.rate > 0) {
    return {
      rate: data.rate,
      fxAsOf: data.rate_date,
      fxSource: "FX_RATES_TABLE",
    };
  }

  return {
    rate: getEurToUsdRate(),
    fxAsOf: null,
    fxSource: "ENV_EUR_TO_USD_RATE",
  };
}
