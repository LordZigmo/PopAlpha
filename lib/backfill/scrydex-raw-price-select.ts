// Pure (no DB / no server-only) Scrydex raw price selection logic.
//
// This module is intentionally isolated from the rest of the normalize
// pipeline so it can be unit-tested without dragging in Supabase or any
// `server-only` imports. It mirrors `selectScrydexRawHistoryPrice` in
// `scrydex-price-history.ts` — both paths must apply the same hard filters
// so that `price_snapshots` (daily normalize) and `price_history_points`
// (history backfill) agree on what qualifies as a "raw Near Mint" price.
//
// Contamination history: before this module existed, the daily normalize
// `selectPreferredScrydexPriceEntry` only *ranked* prices without enforcing
// filters, and would fall through to graded rows (e.g. PSA 10 at $157) when
// a card's raw-NM row was present but had empty market/low/mid/high fields.
// Combined with a `normalizeScrydexCondition` default of `"nm"` for missing
// condition strings, graded prices were being written to `price_snapshots`
// rows tagged `grade='RAW'` and bleeding into the market_price surfaced to
// the iOS scanner and homepage.

import { normalizeCondition } from "@/lib/providers/justtcg";

export type ScrydexCurrency = "USD" | "EUR" | "JPY";

export type SelectedScrydexPriceEntry = {
  price: number;
  currency: ScrydexCurrency;
  row: Record<string, unknown>;
  providerCondition: string | null;
  normalizedCondition: string;
};

export function getNumberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function normalizeScrydexCurrency(raw: unknown): ScrydexCurrency {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "EUR") return "EUR";
  if (value === "JPY") return "JPY";
  return "USD";
}

export function parseScrydexPriceObject(
  record: Record<string, unknown>,
): { price: number | null; currency: ScrydexCurrency } {
  const directCurrency = normalizeScrydexCurrency(record.currency);
  const directCandidates = [
    record.marketPrice,
    record.market,
    record.lowest_near_mint,
    record.low,
    record.mid,
    record.average,
    record.avg,
    record.price,
    record.value,
  ];
  for (const candidate of directCandidates) {
    const value = getNumberField(candidate);
    if (value !== null) {
      return {
        price: value,
        currency: directCurrency,
      };
    }
  }

  const usdValue = getNumberField(record.usd) ?? getNumberField(record.USD);
  if (usdValue !== null) return { price: usdValue, currency: "USD" };

  const eurValue = getNumberField(record.eur) ?? getNumberField(record.EUR);
  if (eurValue !== null) return { price: eurValue, currency: "EUR" };

  const jpyValue = getNumberField(record.jpy) ?? getNumberField(record.JPY);
  if (jpyValue !== null) return { price: jpyValue, currency: "JPY" };

  return { price: null, currency: "USD" };
}

export function normalizeScrydexCondition(condition: unknown): {
  providerCondition: string | null;
  normalizedCondition: string;
} {
  const providerCondition = typeof condition === "string" && condition.trim()
    ? condition.trim()
    : null;
  // No default-to-"nm": an unknown/missing condition must NOT be treated as
  // Near Mint, or graded rows slip past the downstream raw-condition filter.
  return {
    providerCondition,
    normalizedCondition: providerCondition ? normalizeCondition(providerCondition) : "unknown",
  };
}

/**
 * Select the best Near Mint / Mint raw-ungraded price entry from a Scrydex
 * `prices` array (or single price object). Hard rejects:
 *   - `type` set and not `"raw"` (graded entries)
 *   - `is_error`, `is_signed`, `is_perfect`
 *   - `condition` not normalizing to `"nm"` or `"mint"` (including missing)
 *   - rows with no positive market/low/mid/high
 *
 * When nothing qualifies we return `null` — callers must skip the observation
 * rather than fabricating a substitute from a non-qualifying row.
 */
export function selectPreferredScrydexPriceEntry(prices: unknown): SelectedScrydexPriceEntry | null {
  const rows: Record<string, unknown>[] = Array.isArray(prices)
    ? prices.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    : (prices && typeof prices === "object" ? [prices as Record<string, unknown>] : []);
  if (rows.length === 0) return null;

  let best: { score: number; selected: SelectedScrydexPriceEntry } | null = null;

  for (const row of rows) {
    const rawType = String(row.type ?? "").trim().toLowerCase();
    if (rawType && rawType !== "raw") continue;
    if (row.is_error === true || row.is_signed === true || row.is_perfect === true) continue;

    const condition = normalizeScrydexCondition(row.condition);
    if (condition.normalizedCondition !== "nm" && condition.normalizedCondition !== "mint") continue;

    const parsed = parseScrydexPriceObject(row);
    if (parsed.price === null) continue;

    let score = 0;
    if (condition.normalizedCondition === "nm") score += 100;
    if (condition.normalizedCondition === "mint") score += 90;
    if (getNumberField(row.market) !== null) score += 20;
    if (getNumberField(row.low) !== null) score += 10;

    const selected: SelectedScrydexPriceEntry = {
      price: parsed.price,
      currency: parsed.currency,
      row,
      providerCondition: condition.providerCondition,
      normalizedCondition: condition.normalizedCondition,
    };
    if (!best || score > best.score) {
      best = { score, selected };
    }
  }

  return best?.selected ?? null;
}
