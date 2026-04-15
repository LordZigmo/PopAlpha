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
 * Every API route, including debug routes, must be listed here explicitly
 * so build-time guardrails can enforce the trust model per route.
 */

export const PUBLIC_ROUTES = [
  "cards/live-activity",
  "community-pulse/crowd",
  "market-signals",
  "cards/[slug]/detail",
  "cards/[slug]/poketrace",
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
  "poketrace/mobile-samples",
  "handles/availability",
  "health",
  "homepage",
  "homepage/ai-brief",
  "homepage/community",
  "waitlist",
];

export const CRON_ROUTES = [
  "cron/ingest-fx-rates",
  "cron/check-fx-rates-health",
  "cron/ingest-justtcg-raw",
  "cron/ingest-pokemontcg-raw",
  "cron/normalize-justtcg-raw",
  "cron/normalize-poketrace-raw",
  "cron/normalize-pokemontcg-raw",
  "cron/match-justtcg-normalized",
  "cron/match-pokemontcg-normalized",
  "cron/write-provider-timeseries",
  "cron/run-justtcg-pipeline",
  "cron/run-justtcg-retry",
  "cron/run-scrydex-pipeline",
  "cron/run-scrydex-daily/[chunk]",
  "cron/backfill-scrydex-price-history",
  "cron/run-scrydex-2024plus-catchup",
  "cron/run-scrydex-2024plus-daily/[chunk]",
  "cron/run-scrydex-retry",
  "cron/run-poketrace-pipeline",
  "cron/run-pokemontcg-pipeline",
  "cron/process-provider-pipeline-jobs",
  "cron/process-ebay-deletion-receipts",
  "cron/sync-canonical",
  "cron/sync-tcg-prices",
  "cron/refresh-card-metrics",
  "cron/batch-refresh-pipeline-rollups",
  "cron/refresh-card-embeddings",
  "cron/capture-pricing-transparency",
  "cron/capture-matching-quality",
  "cron/snapshot-price-history",
  "cron/refresh-derived-signals",
  "cron/refresh-set-summaries",
  "cron/refresh-ai-brief",
  "cron/refresh-card-profiles",
  "cron/prune-old-data",
];

export const ADMIN_ROUTES = [
  "admin/ebay-deletion-tasks",
  "admin/ebay-deletion-tasks/[id]",
  "admin/import/pokemontcg-canonical",
  "admin/import/scrydex-canonical",
  "admin/import/pokemontcg",
  "admin/import/printings",
  "admin/psa-seeds",
];

export const DEBUG_ROUTES = [
  "debug/asset-inspect",
  "debug/justtcg-inspect",
  "debug/justtcg-match-summary",
  "debug/justtcg-normalized-signals",
  "debug/justtcg-raw-signals",
  "debug/justtcg-unmatched-diagnostics",
  "debug/justtcg/backfill-first-edition-printings",
  "debug/justtcg/backfill-set",
  "debug/justtcg/backfill-tracked-mappings",
  "debug/justtcg/precheck-repair-sets",
  "debug/justtcg/repair-pokeball-stamp",
  "debug/justtcg/repair-set-finishes",
  "debug/market-summary",
  "debug/provider-price-readings",
  "debug/tracked-assets",
  "debug/tracked-assets/seed",
  "debug/tracked-refresh-diagnostics",
  "debug/pipeline-health",
];

export const INGEST_ROUTES = [
  "market/observe",
  "ingest/psa",
  "ebay/deletion-notification",
];

export const USER_ROUTES = [
  "activity/card",
  "activity/comments",
  "activity/feed",
  "activity/like",
  "activity/notifications",
  "activity/notifications/read",
  "activity/profile",
  "community-pulse",
  "private-sales",
  "private-sales/[id]",
  "pro/signals",
  "holdings",
  "holdings/summary",
  "homepage/me",
  "me",
  "me/export",
  "me/push",
  "me/push/test",
  "onboarding/handle",
  "settings",
  "profile",
  "profile/banner",
  "profile/follow",
  "profile/posts",
  "profile/posts/[id]",
  "wishlist",
];
