/**
 * Single source of truth for API route classification.
 *
 * Imported by:
 *   - middleware.ts          (runtime route classification)
 *   - scripts/check-route-coverage.mjs  (build-time coverage check)
 *
 * Every route key is the path segment after /api/ with dynamic segments
 * written as [param], e.g. "cards/[slug]/detail", "private-sales/[id]".
 *
 * The "debug" prefix is treated as a subtree — individual debug routes
 * do NOT need to be listed here.
 */

export const PUBLIC_ROUTES = [
  "cards/[slug]/detail",
  "search/cards",
  "search/suggest",
  "canonical/match",
  "market/snapshot",
  "tcg/pricing",
  "tcg/sets/search",
  "psa/cert",
  "psa/cert/activity",
  "ebay/browse",
  "card-profiles",
];

export const CRON_ROUTES = [
  "cron/sync-canonical",
  "cron/sync-tcg-prices",
  "cron/sync-justtcg-prices",
  "cron/refresh-card-metrics",
  "cron/snapshot-price-history",
  "cron/refresh-derived-signals",
  "cron/refresh-set-summaries",
];

export const ADMIN_ROUTES = [
  "admin/import/pokemontcg-canonical",
  "admin/import/pokemontcg",
  "admin/import/printings",
  "admin/psa-seeds",
];

export const INGEST_ROUTES = [
  "market/observe",
  "ingest/psa",
  "ebay/deletion-notification",
];

export const USER_ROUTES = [
  "private-sales",
  "private-sales/[id]",
  "pro/signals",
  "holdings",
];
