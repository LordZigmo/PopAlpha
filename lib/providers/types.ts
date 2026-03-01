/**
 * Shared canonical types for the provider layer.
 *
 * Any price source normalizes its output into these internal DTOs before
 * writing to our DB. Nothing outside lib/providers should import raw
 * provider response types.
 */

/** A single normalized price point written to price_snapshots. */
export type NormalizedPricePoint = {
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
  price_value: number;
  currency: string;
  provider: string;
  /** Provider's own unique ID for this price point (upsert dedup key). */
  provider_ref: string;
  ingest_id: string | null;
  observed_at: string;
};

/**
 * A single historical price point from a provider's time-series data.
 * Written to price_history_points with ON CONFLICT DO NOTHING.
 *
 * variant_ref: stable cohort key. Printing-backed rows use the canonical
 * identity format "<printing_id>::RAW" or "<printing_id>::<PROVIDER>::<GRADE_BUCKET>".
 * Legacy sealed rows may still use a provider-shaped fallback until sealed
 * has a printing_id axis.
 */
export type PriceHistoryPoint = {
  canonical_slug: string;
  variant_ref: string;   // e.g. "<printing_id>::RAW"
  provider: string;
  ts: string;            // ISO 8601
  price: number;
  currency: string;
  source_window: string; // e.g. '30d'
};

/**
 * Provider-supplied pre-computed analytics for a card variant.
 * Column names match the provider_* columns added to card_metrics in
 * migration 20260301090000.
 */
export type MetricsSnapshot = {
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
  provider: string;
  provider_as_of_ts: string;
  price_value: number;
  // The 4 core signals shipping this weekend:
  provider_trend_slope_7d: number | null;
  provider_cov_price_30d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_min_price_all_time: number | null;
  provider_max_price_all_time: number | null;
  // Supporting context:
  provider_trend_slope_30d: number | null;
  provider_cov_price_7d: number | null;
  provider_min_price_all_time_date: string | null;
  provider_max_price_all_time_date: string | null;
  // Activity proxy (count of price changes in the last 30 days).
  provider_price_changes_count_30d: number | null;
};
