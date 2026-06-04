/**
 * lib/backfill/refresh-tier-skip-policy.ts
 *
 * Phase 3 of the tiered-refresh plan (2026-05-06), revised 2026-06-04.
 * Bounds the 5-table write amplification on low-activity cards while
 * keeping a usable price series for the 24h/7d change computation. Single
 * source of truth for the per-tier decision so the timeseries and
 * variant-metrics stages can't drift apart.
 *
 * History points (price_history_points — the series the change metric reads):
 *   hot      Always write.
 *   warm     Floor cadence: write on a material price move OR when the last
 *            write is >= 48h old.
 *   sparse   Same floor cadence as warm. (Previously skipped history entirely,
 *            which starved the 24h/7d change — with sparse never writing a
 *            point, only ~117 EN cards had a computable 24h change. Writing on
 *            the floor cadence rebuilds a daily-ish series so the change can
 *            compute. Credit-neutral: only changes what we do with the
 *            observations the pipeline has already fetched, not the fetch rate.)
 *   dormant  Same floor cadence (Phase 4 will cut the fetch entirely; until
 *            then any incidental observation follows the floor cadence).
 *   unknown  Fail open — write (never seen this card; capture it).
 *
 * variant_metrics are intentionally NOT changed by this revision: rare-trade
 * stats stay too noisy to be useful, so sparse/dormant still skip them
 * (see shouldRefreshVariantMetrics).
 *
 * Snapshot rows are always written for any non-NULL tier (the source for the
 * "Last sold $X · {date}" UX); skipping would freeze the as_of timestamp.
 *
 * Env: PIPELINE_TIER_SKIP_ENABLED. Default ON. Set to "false" to fall through
 * to unconditional "always write" across both stages.
 */

export type RefreshTier = "hot" | "warm" | "sparse" | "dormant" | "unknown";

export const PIPELINE_TIER_SKIP_ENABLED =
  process.env.PIPELINE_TIER_SKIP_ENABLED !== "false";

// Floor cadence for all non-hot tiers (warm/sparse/dormant): write a history
// point when the price moved materially since the last write, or when the last
// write is at least this old — so slow-moving cards still keep a series before
// they drift out of the 24h/7d change windows.
const FLOOR_PRICE_DELTA_PCT = 0.005;
const FLOOR_MIN_REWRITE_AGE_MS = 48 * 60 * 60 * 1000;

function normalizeTier(value: string | null | undefined): RefreshTier {
  if (value === "hot" || value === "warm" || value === "sparse" || value === "dormant") {
    return value;
  }
  return "unknown";
}

/**
 * Decide whether to push a price_history_point row for an observation.
 * Snapshot writes are unaffected — those decisions live at the call
 * site (always write).
 */
export function shouldWriteHistoryPoint(input: {
  tier: string | null | undefined;
  observedAtIso: string;
  observedPriceUsd: number;
  latestSnapshotObservedAtIso: string | null;
  latestSnapshotPriceUsd: number | null;
}): boolean {
  if (!PIPELINE_TIER_SKIP_ENABLED) return true;
  const tier = normalizeTier(input.tier);
  if (tier === "hot") return true;
  if (tier === "unknown") return true; // fail open — never seen this card before, capture it
  // warm / sparse / dormant: floor cadence — write on a material price move OR
  // when the prior write is >= 48h old, so every non-hot card keeps a daily-ish
  // price series for the 24h/7d change computation. (sparse/dormant used to
  // return false here, which starved the change metric.)
  const lastTsMs = input.latestSnapshotObservedAtIso
    ? new Date(input.latestSnapshotObservedAtIso).getTime()
    : null;
  const observedTsMs = new Date(input.observedAtIso).getTime();
  if (lastTsMs === null || !Number.isFinite(lastTsMs)) return true;
  if (Number.isFinite(observedTsMs) && observedTsMs - lastTsMs >= FLOOR_MIN_REWRITE_AGE_MS) return true;
  if (input.latestSnapshotPriceUsd === null || input.latestSnapshotPriceUsd <= 0) return true;
  const deltaPct = Math.abs(input.observedPriceUsd - input.latestSnapshotPriceUsd) / input.latestSnapshotPriceUsd;
  return deltaPct >= FLOOR_PRICE_DELTA_PCT;
}

/**
 * Decide whether to refresh variant_metrics for a touched canonical
 * card. Hot always; warm only on material change since last metrics
 * write; sparse/dormant never (rare-trade stats stay too noisy).
 */
export function shouldRefreshVariantMetrics(input: {
  tier: string | null | undefined;
  observedAtIso: string;
  currentMetricsAsOfIso: string | null;
}): boolean {
  if (!PIPELINE_TIER_SKIP_ENABLED) return true;
  const tier = normalizeTier(input.tier);
  if (tier === "hot") return true;
  if (tier === "sparse" || tier === "dormant") return false;
  if (tier === "unknown") return true;
  // warm: refresh only when this observation is newer than the existing
  // metrics row's as_of (i.e. there's something new to capture).
  const observedMs = new Date(input.observedAtIso).getTime();
  const metricsMs = input.currentMetricsAsOfIso
    ? new Date(input.currentMetricsAsOfIso).getTime()
    : null;
  if (!Number.isFinite(observedMs)) return true;
  if (metricsMs === null || !Number.isFinite(metricsMs)) return true;
  return observedMs > metricsMs;
}
