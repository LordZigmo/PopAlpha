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
  "cards/[slug]/view",
  "scan/identify",
  // Anchor delta sync for the offline scanner. Returns user_correction
  // rows (slug + metadata + 768d embedding) added since a watermark.
  // Public read because the data is derived from the public catalog
  // and non-PII corrections; the .papb base catalog is also publicly
  // served.
  "catalog/anchors-since",
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
  "homepage",
  "homepage/ai-brief",
  "homepage/community",
  "personalization/events",
  "personalization/explanation",
  "personalization/profile",
  "waitlist",
];

export const CRON_ROUTES = [
  "cron/ingest-fx-rates",
  "cron/check-fx-rates-health",
  "cron/write-provider-timeseries",
  "cron/run-scrydex-pipeline",
  "cron/run-scrydex-daily/[chunk]",
  "cron/backfill-scrydex-price-history",
  "cron/run-scrydex-2024plus-catchup",
  "cron/run-scrydex-2024plus-daily/[chunk]",
  "cron/run-scrydex-retry",
  "cron/process-provider-pipeline-jobs",
  "cron/process-ebay-deletion-receipts",
  "cron/sync-canonical",
  "cron/sync-tcg-prices",
  "cron/refresh-card-metrics",
  "cron/batch-refresh-pipeline-rollups",
  "cron/refresh-card-embeddings",
  "cron/refresh-card-image-embeddings",
  "cron/augment-card-image-embeddings",
  "cron/embed-card-art-crops",
  "cron/keepwarm-image-embedder",
  "cron/capture-pricing-transparency",
  "cron/capture-matching-quality",
  "cron/snapshot-price-history",
  "cron/refresh-derived-signals",
  "cron/refresh-set-summaries",
  "cron/refresh-ai-brief",
  "cron/refresh-card-profiles",
  "cron/downsample-price-history",
  "cron/prune-old-data",
  "cron/mirror-card-images",
  "cron/compute-daily-top-movers",
  "cron/discover-new-sets",
  "admin/cleanup/delete-thumb-overlay-augs",
];

export const ADMIN_ROUTES = [
  "admin/ebay-deletion-tasks",
  "admin/ebay-deletion-tasks/[id]",
  "admin/import/scrydex-canonical",
  "admin/import/printings",
  "admin/psa-seeds",
  "admin/discover-sets",
  "admin/scan-eval/promote",
  "admin/scan-eval/pre-label",
  // 2026-04-29: admin/variant-tokens registry entry was committed
  // ahead of its implementation files (still untracked locally:
  // app/api/admin/variant-tokens/route.ts + sibling lib/internal pages).
  // Vercel build was failing on internal-route-trust because the
  // route file isn't in git, so the entry was reverted to unblock the
  // recipe-v2-thumb-overlay cleanup deploy. Re-add when committing
  // the matching feature files.
];

export const DEBUG_ROUTES = [
  "debug/asset-inspect",
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
  // Premium offline scanner correction. User reports a wrong scan
  // via the picker; this endpoint creates a kNN anchor (source =
  // 'user_correction') tagged with the active embedder's
  // model_version so the offline catalog's anchor sync surfaces it.
  // Distinct from /api/admin/scan-eval/promote which ALSO writes to
  // scan_eval_images (the curated training corpus, admin-only).
  "scan/correction",
  "holdings",
  "holdings/bulk-import",
  "holdings/summary",
  "portfolio/overview",
  "portfolio/activity",
  "homepage/me",
  "me",
  "me/export",
  "me/push",
  "me/push/test",
  "device/register",
  "device/test-push",
  "onboarding/handle",
  "settings",
  "profile",
  "profile/banner",
  "profile/follow",
  "profile/posts",
  "profile/posts/[id]",
  "wishlist",
];
