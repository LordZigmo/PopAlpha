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

// ── Graded extraction ─────────────────────────────────────────────────────────

const RECOGNIZED_GRADED_PROVIDERS = new Set(["PSA", "CGC", "BGS", "TAG"]);

/**
 * Map Scrydex grade strings (e.g. "10", "9.5", "8") to our internal grade
 * bucket vocabulary. Returns null for unrecognized grades — callers must
 * skip the row, never default or fabricate.
 */
const SCRYDEX_GRADE_MAP: Record<string, string> = {
  "10": "G10",
  "9.5": "G9_5",
  "9": "G9",
  "8.5": "G9",    // Round 8.5 up to G9 bucket (closest available)
  "8": "G8",
  "7.5": "LE_7",
  "7": "LE_7",
  "6.5": "LE_7",
  "6": "LE_7",
  "5.5": "LE_7",
  "5": "LE_7",
  "4.5": "LE_7",
  "4": "LE_7",
  "3.5": "LE_7",
  "3": "LE_7",
  "2.5": "LE_7",
  "2": "LE_7",
  "1.5": "LE_7",
  "1": "LE_7",
};

export type SelectedScrydexGradedEntry = {
  provider: string;
  gradeBucket: string;
  price: number;
  low: number | null;
  high: number | null;
  currency: ScrydexCurrency;
  row: Record<string, unknown>;
  isPerfect: boolean;
};

/**
 * Extract ALL qualifying graded price entries from a Scrydex `prices` array.
 * Returns one entry per (provider, gradeBucket) pair. Unlike the raw selector
 * which picks a single "best" row, graded extraction fans out to all tiers.
 *
 * Hard rejects:
 *   - `type` not `"graded"` (or missing)
 *   - `is_error === true` or `is_signed === true`
 *   - `company` missing or not one of PSA/CGC/BGS/TAG
 *   - `grade` missing or not mappable via SCRYDEX_GRADE_MAP
 *   - no positive market/low/mid/high
 *
 * Special handling:
 *   - `is_perfect === true` routes to G10_PERFECT regardless of grade value
 *   - Deduplicates by (provider, gradeBucket): keeps the entry with the
 *     highest-scored price fields (market > low > mid > high)
 */
export function selectScrydexGradedEntries(prices: unknown): SelectedScrydexGradedEntry[] {
  if (!Array.isArray(prices)) return [];

  const rows = prices.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
  );
  if (rows.length === 0) return [];

  // Track best per (provider, gradeBucket) to deduplicate
  const bestByKey = new Map<string, { score: number; entry: SelectedScrydexGradedEntry }>();

  for (const row of rows) {
    const rawType = String(row.type ?? "").trim().toLowerCase();
    if (rawType !== "graded") continue;
    if (row.is_error === true || row.is_signed === true) continue;

    const company = String(row.company ?? "").trim().toUpperCase();
    if (!RECOGNIZED_GRADED_PROVIDERS.has(company)) continue;

    const isPerfect = row.is_perfect === true;
    const rawGrade = String(row.grade ?? "").trim();

    let gradeBucket: string | null;
    if (isPerfect) {
      gradeBucket = "G10_PERFECT";
    } else {
      gradeBucket = SCRYDEX_GRADE_MAP[rawGrade] ?? null;
    }
    if (!gradeBucket) continue;

    const parsed = parseScrydexPriceObject(row);
    if (parsed.price === null) continue;

    let score = 0;
    if (getNumberField(row.market) !== null) score += 20;
    if (getNumberField(row.low) !== null) score += 10;

    const entry: SelectedScrydexGradedEntry = {
      provider: company,
      gradeBucket,
      price: parsed.price,
      low: getNumberField(row.low),
      high: getNumberField(row.high),
      currency: parsed.currency,
      row,
      isPerfect,
    };

    const key = `${company}::${gradeBucket}`;
    const existing = bestByKey.get(key);
    if (!existing || score > existing.score) {
      bestByKey.set(key, { score, entry });
    }
  }

  return Array.from(bestByKey.values()).map((v) => v.entry);
}
