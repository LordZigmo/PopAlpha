import type { SupabaseClient } from "@supabase/supabase-js";
import { getEurToUsdRate, getJpyToUsdRate } from "@/lib/pricing/fx";

export type PriceHistoryFxRateRow = {
  pair: string | null;
  rate: number;
  rate_date: string;
};

export type PriceHistoryCurrencyRow = {
  price: number;
  currency: string | null;
  ts: string | null;
};

const SUPPORTED_HISTORY_FX_PAIRS = ["EURUSD", "JPYUSD"] as const;

function normalizedCurrency(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || null;
}

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function pairForCurrency(currency: string): "EURUSD" | "JPYUSD" | null {
  if (currency === "EUR") return "EURUSD";
  if (currency === "JPY") return "JPYUSD";
  return null;
}

function fallbackRateForCurrency(currency: string): number | null {
  if (currency === "EUR") return getEurToUsdRate();
  if (currency === "JPY") return getJpyToUsdRate();
  return null;
}

function findRateForDate(
  fxRows: PriceHistoryFxRateRow[],
  pair: string,
  isoDate: string,
): number | null {
  let best: number | null = null;
  for (const row of fxRows) {
    if (String(row.pair ?? "").trim().toUpperCase() !== pair) continue;
    if (row.rate_date <= isoDate) best = row.rate;
    else break;
  }
  return best;
}

export function convertPriceHistoryRowToUsd(
  row: PriceHistoryCurrencyRow,
  fxRows: PriceHistoryFxRateRow[] = [],
): number | null {
  if (!Number.isFinite(row.price) || row.price <= 0) return null;
  const currency = normalizedCurrency(row.currency);
  if (currency === "USD") return row.price;
  if (!currency) return null;

  const pair = pairForCurrency(currency);
  if (!pair) return null;

  const isoDate = toIsoDate(row.ts);
  const fxRate = (isoDate ? findRateForDate(fxRows, pair, isoDate) : null)
    ?? fallbackRateForCurrency(currency);
  if (!Number.isFinite(fxRate) || fxRate === null || fxRate <= 0) return null;
  return Number((row.price * fxRate).toFixed(4));
}

export async function loadPriceHistoryFxRows(
  supabase: SupabaseClient,
  asOfDate: string | null,
): Promise<PriceHistoryFxRateRow[]> {
  if (!asOfDate) return [];
  const { data, error } = await supabase
    .from("fx_rates")
    .select("pair, rate, rate_date")
    .in("pair", [...SUPPORTED_HISTORY_FX_PAIRS])
    .lte("rate_date", asOfDate)
    .order("pair", { ascending: true })
    .order("rate_date", { ascending: true });
  if (error) {
    throw new Error(`Failed to load price history FX rows: ${error.message}`);
  }
  return (data ?? []) as PriceHistoryFxRateRow[];
}
