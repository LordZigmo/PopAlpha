// Extract ALL raw condition prices from a Scrydex prices array.
//
// This is a companion to selectPreferredScrydexPriceEntry() (which only
// returns the best NM/Mint entry). This module returns a Map of ALL
// recognized raw conditions so the pipeline can write condition-based
// pricing to card_condition_prices.
//
// The existing NM pipeline is NOT modified by this module.

import {
  normalizeScrydexCondition,
  parseScrydexPriceObject,
  getNumberField,
  type ScrydexCurrency,
} from "@/lib/backfill/scrydex-raw-price-select";

export type ConditionPriceEntry = {
  price: number;
  lowPrice: number | null;
  highPrice: number | null;
  currency: ScrydexCurrency;
  providerCondition: string | null;
  normalizedCondition: string;
};

const RECOGNIZED_RAW_CONDITIONS = new Set(["nm", "mint", "lp", "mp", "hp", "dmg"]);

/**
 * Extract prices for ALL recognized raw conditions from a Scrydex prices
 * array. Returns a Map keyed by normalized condition (nm, lp, mp, hp, dmg).
 * "mint" entries are merged into "nm" (nm wins if both exist).
 *
 * Same hard rejection filters as selectPreferredScrydexPriceEntry:
 *   - type set and not "raw"
 *   - is_error / is_signed / is_perfect
 *   - unrecognized conditions
 *   - no positive price in market/low/mid/high
 */
export function selectAllScrydexConditionPrices(
  prices: unknown,
): Map<string, ConditionPriceEntry> {
  const rows: Record<string, unknown>[] = Array.isArray(prices)
    ? prices.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    : (prices && typeof prices === "object" ? [prices as Record<string, unknown>] : []);

  const result = new Map<string, { score: number; entry: ConditionPriceEntry }>();

  for (const row of rows) {
    // Same hard filters as selectPreferredScrydexPriceEntry
    const rawType = String(row.type ?? "").trim().toLowerCase();
    if (rawType && rawType !== "raw") continue;
    if (row.is_error === true || row.is_signed === true || row.is_perfect === true) continue;

    const condition = normalizeScrydexCondition(row.condition);
    if (!RECOGNIZED_RAW_CONDITIONS.has(condition.normalizedCondition)) continue;

    const parsed = parseScrydexPriceObject(row);
    if (parsed.price === null) continue;

    // Scoring: prefer rows with more price fields available
    let score = 0;
    if (getNumberField(row.market) !== null) score += 20;
    if (getNumberField(row.low) !== null) score += 10;
    if (getNumberField(row.high) !== null) score += 5;

    // Normalize "mint" into "nm" bucket (nm wins on score tie)
    const key = condition.normalizedCondition === "mint" ? "nm" : condition.normalizedCondition;
    if (key === "nm" && condition.normalizedCondition === "nm") score += 10; // prefer "nm" over "mint"

    const entry: ConditionPriceEntry = {
      price: parsed.price,
      lowPrice: getNumberField(row.low),
      highPrice: getNumberField(row.high),
      currency: parsed.currency,
      providerCondition: condition.providerCondition,
      normalizedCondition: key,
    };

    const existing = result.get(key);
    if (!existing || score > existing.score) {
      result.set(key, { score, entry });
    }
  }

  // Flatten to just entries
  const output = new Map<string, ConditionPriceEntry>();
  for (const [key, { entry }] of result) {
    output.set(key, entry);
  }
  return output;
}
