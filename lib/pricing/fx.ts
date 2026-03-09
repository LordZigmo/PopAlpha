import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_EUR_TO_USD_RATE = 1.08;
const DEFAULT_JPY_TO_USD_RATE = 0.0068;

type FxSource =
  | "FX_RATES_TABLE"
  | "ENV_EUR_TO_USD_RATE"
  | "ENV_JPY_TO_USD_RATE"
  | "IDENTITY";

function parsePositiveRate(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function getEurToUsdRate(): number {
  return parsePositiveRate(process.env.EUR_TO_USD_RATE) ?? DEFAULT_EUR_TO_USD_RATE;
}

export function getJpyToUsdRate(): number {
  return parsePositiveRate(process.env.JPY_TO_USD_RATE) ?? DEFAULT_JPY_TO_USD_RATE;
}

export function convertToUsd(value: number, currency: string): number {
  if (!Number.isFinite(value) || value <= 0) return value;
  const normalizedCurrency = String(currency).trim().toUpperCase();
  if (normalizedCurrency === "USD") return value;
  if (normalizedCurrency === "EUR") {
    const rate = getEurToUsdRate();
    return Number((value * rate).toFixed(4));
  }
  if (normalizedCurrency === "JPY") {
    const rate = getJpyToUsdRate();
    return Number((value * rate).toFixed(4));
  }
  return value;
}

function getPairForCurrency(currency: string): string | null {
  const normalizedCurrency = String(currency).trim().toUpperCase();
  if (normalizedCurrency === "EUR") return "EURUSD";
  if (normalizedCurrency === "JPY") return "JPYUSD";
  return null;
}

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export async function getCurrencyToUsdRateAt(params: {
  supabase: SupabaseClient;
  currency: string;
  asOf: string | null | undefined;
}): Promise<{
  rate: number;
  fxAsOf: string | null;
  fxSource: FxSource;
}> {
  const normalizedCurrency = String(params.currency).trim().toUpperCase();
  if (normalizedCurrency === "USD") {
    return {
      rate: 1,
      fxAsOf: null,
      fxSource: "IDENTITY",
    };
  }

  const asOfDate = toIsoDate(params.asOf) ?? new Date().toISOString().slice(0, 10);
  const pair = getPairForCurrency(normalizedCurrency);

  if (pair) {
    const { data, error } = await params.supabase
      .from("fx_rates")
      .select("rate, rate_date")
      .eq("pair", pair)
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
  }

  if (normalizedCurrency === "EUR") {
    return {
      rate: getEurToUsdRate(),
      fxAsOf: null,
      fxSource: "ENV_EUR_TO_USD_RATE",
    };
  }

  if (normalizedCurrency === "JPY") {
    return {
      rate: getJpyToUsdRate(),
      fxAsOf: null,
      fxSource: "ENV_JPY_TO_USD_RATE",
    };
  }

  return {
    rate: 1,
    fxAsOf: null,
    fxSource: "IDENTITY",
  };
}

export async function getEurToUsdRateAt(params: {
  supabase: SupabaseClient;
  asOf: string | null | undefined;
}): Promise<{
  rate: number;
  fxAsOf: string | null;
  fxSource: "FX_RATES_TABLE" | "ENV_EUR_TO_USD_RATE";
}> {
  const result = await getCurrencyToUsdRateAt({
    supabase: params.supabase,
    currency: "EUR",
    asOf: params.asOf,
  });

  return {
    rate: result.rate,
    fxAsOf: result.fxAsOf,
    fxSource: result.fxSource === "FX_RATES_TABLE" ? "FX_RATES_TABLE" : "ENV_EUR_TO_USD_RATE",
  };
}
