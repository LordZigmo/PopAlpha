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
  "cards/live-activity",
  "community-pulse/crowd",
  "market-signals",
  "cards/[slug]/detail",
  "cards/[slug]/view",
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
  "handles/availability",
  "health",
];

export const CRON_ROUTES = [
  "cron/sync-canonical",
  "cron/sync-tcg-prices",
  "cron/sync-justtcg-prices",
  "cron/sync-pokedata-prices",
  "cron/refresh-card-metrics",
  "cron/refresh-card-embeddings",
  "cron/snapshot-price-history",
  "cron/refresh-derived-signals",
  "cron/refresh-set-summaries",
  "cron/sync-pokemon-tcg-graded",
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
  "community-pulse",
  "private-sales",
  "private-sales/[id]",
  "pro/signals",
  "holdings",
  "holdings/summary",
  "onboarding/handle",
  "me",
  "me/push",
  "me/push/test",
  "settings",
  "profile",
  "profile/banner",
  "profile/follow",
  "profile/posts",
  "profile/posts/[id]",
];
