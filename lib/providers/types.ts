/**
 * Shared canonical types for the provider layer.
 *
 * Any price source (JustTCG, TCGPlayer, eBay, ...) normalizes its output
 * into NormalizedPricePoint before writing to price_snapshots.
 */

export type NormalizedPricePoint = {
  /** FK to canonical_cards.slug */
  canonical_slug: string;
  /** FK to card_printings.id — null means no specific printing resolved */
  printing_id: string | null;
  /** 'RAW' | 'PSA9' | 'PSA10' | ... */
  grade: string;
  price_value: number;
  currency: string;
  /** Provider name stored in price_snapshots.provider */
  provider: string;
  /** Provider's own unique ID for this price point (used for upsert dedup) */
  provider_ref: string;
  /** FK to provider_ingests.id */
  ingest_id: string | null;
  observed_at: string;
};
