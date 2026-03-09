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
  "waitlist",
];

export const CRON_ROUTES = [
  "cron/ingest-fx-rates",
  "cron/check-fx-rates-health",
  "cron/ingest-justtcg-raw",
  "cron/ingest-pokemontcg-raw",
  "cron/normalize-justtcg-raw",
  "cron/normalize-pokemontcg-raw",
  "cron/match-justtcg-normalized",
  "cron/match-pokemontcg-normalized",
  "cron/write-provider-timeseries",
  "cron/run-justtcg-pipeline",
  "cron/run-justtcg-retry",
  "cron/run-scrydex-pipeline",
  "cron/run-scrydex-retry",
  "cron/run-poketrace-pipeline",
  "cron/run-pokemontcg-pipeline",
  "cron/process-provider-pipeline-jobs",
  "cron/sync-canonical",
  "cron/sync-tcg-prices",
  "cron/refresh-card-metrics",
  "cron/refresh-card-embeddings",
  "cron/capture-pricing-transparency",
  "cron/capture-matching-quality",
  "cron/snapshot-price-history",
  "cron/refresh-derived-signals",
  "cron/refresh-set-summaries",
];

export const ADMIN_ROUTES = [
  "admin/import/pokemontcg-canonical",
  "admin/import/scrydex-canonical",
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
