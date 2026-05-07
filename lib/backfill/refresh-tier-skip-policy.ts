/**
 * lib/backfill/refresh-tier-skip-policy.ts
 *
 * Phase 3 of the tiered-refresh plan (2026-05-06). Stops the 5-table
 * write amplification on the ~12k sparse/dormant cards whose prices
 * aren't moving. Single source of truth for the per-tier decision so
 * timeseries and variant-metrics stages can't drift apart.
 *
 * What we skip per tier:
 *   hot      Always write everything (snapshot + history + variant_metrics).
 *   warm     Snapshot always. History + metrics only if the price moved
 *            materially OR the last write is >= 48h old (catch
 *            slow-changing cards before they drift out of the 30-day
 *            window).
 *   sparse   Snapshot always. Never write history points. Variant_metrics
 *            only on the FIRST observation per slug (bootstrap row); all
 *            subsequent observations skip — rare-trade cards have noisy
 *            stats anyway, and the homepage rails read off the snapshot
 *            row, not history.
 *   dormant  Snapshot always (Phase 4 cuts the fetch entirely; until
 *            then we let the snapshot row record any incidental
 *            observation). Never write history. Variant_metrics only on
 *            the first observation per slug (same bootstrap as sparse).
 *
 * Snapshot row is intentionally always written for any non-NULL tier
 * because it's the source for the "Last sold $X · {date}" UX shipped
 * in Phase 2. Skipping it would freeze the as_of timestamp at the last
 * pre-Phase-3 fetch.
 *
 * Why the bootstrap exception for variant_metrics on sparse/dormant
 * (added 2026-05-07): without it, brand-new sets hit a permanent
 * catch-22. The tier classifier
 * (compute_refresh_tier — see 20260506013100_fix_compute_refresh_tier_signal.sql)
 * promotes to warm/hot using `provider_price_changes_count_30d`, which
 * comes from variant_metrics. A new set with zero observation history
 * is auto-tagged dormant; with a hard skip it would never get a
 * variant_metrics row, so its change-count stays 0, so the classifier
 * keeps it sparse/dormant forever. Allowing the FIRST write breaks
 * the loop without re-introducing the write amplification this
 * file was created to stop — once the bootstrap row exists,
 * subsequent observations on the same slug skip again.
 *
 * Env: PIPELINE_TIER_SKIP_ENABLED. Default ON. Set to "false" to fall
 * through to today's "always write" behavior across both stages.
 */

export type RefreshTier = "hot" | "warm" | "sparse" | "dormant" | "unknown";

export const PIPELINE_TIER_SKIP_ENABLED =
  process.env.PIPELINE_TIER_SKIP_ENABLED !== "false";

const WARM_PRICE_DELTA_PCT = 0.005;
const WARM_MIN_REWRITE_AGE_MS = 48 * 60 * 60 * 1000;

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
  if (tier === "sparse" || tier === "dormant") return false;
  if (tier === "unknown") return true; // fail open — never seen this card before, capture it
  // warm: write only on material change or stale prior write
  const lastTsMs = input.latestSnapshotObservedAtIso
    ? new Date(input.latestSnapshotObservedAtIso).getTime()
    : null;
  const observedTsMs = new Date(input.observedAtIso).getTime();
  if (lastTsMs === null || !Number.isFinite(lastTsMs)) return true;
  if (Number.isFinite(observedTsMs) && observedTsMs - lastTsMs >= WARM_MIN_REWRITE_AGE_MS) return true;
  if (input.latestSnapshotPriceUsd === null || input.latestSnapshotPriceUsd <= 0) return true;
  const deltaPct = Math.abs(input.observedPriceUsd - input.latestSnapshotPriceUsd) / input.latestSnapshotPriceUsd;
  return deltaPct >= WARM_PRICE_DELTA_PCT;
}

/**
 * Decide whether to refresh variant_metrics for a touched canonical
 * card. Hot always; warm only on material change since last metrics
 * write; sparse/dormant only on the FIRST observation per slug (so the
 * tier classifier has a non-zero `provider_price_changes_count_30d` to
 * work with — see top-of-file comment).
 */
export function shouldRefreshVariantMetrics(input: {
  tier: string | null | undefined;
  observedAtIso: string;
  currentMetricsAsOfIso: string | null;
}): boolean {
  if (!PIPELINE_TIER_SKIP_ENABLED) return true;
  // Bootstrap: always write the first metrics row for a slug regardless
  // of tier. Without this, brand-new sets auto-tagged dormant by the
  // tier classifier never get a variant_metrics row and stay locked in
  // sparse/dormant forever.
  if (input.currentMetricsAsOfIso === null) return true;
  const tier = normalizeTier(input.tier);
  if (tier === "hot") return true;
  if (tier === "sparse" || tier === "dormant") return false;
  if (tier === "unknown") return true;
  // warm: refresh only when this observation is newer than the existing
  // metrics row's as_of (i.e. there's something new to capture).
  const observedMs = new Date(input.observedAtIso).getTime();
  const metricsMs = new Date(input.currentMetricsAsOfIso).getTime();
  if (!Number.isFinite(observedMs)) return true;
  if (!Number.isFinite(metricsMs)) return true;
  return observedMs > metricsMs;
}
