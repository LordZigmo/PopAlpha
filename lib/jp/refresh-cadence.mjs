/**
 * JP tiered-refresh cadence constants.
 *
 * SINGLE DOCUMENTED MIRROR of the cadence intervals hardcoded inside the
 * scan RPCs in supabase/migrations/20260613120000_jp_refresh_tier_cadence.sql
 * (SQL functions cannot import JS — keep the two in sync; the smoke test
 * scripts/__smoke__/jp-refresh-tier-cadence.mjs asserts the invariants that
 * make the matrix safe, so a careless edit here fails fast).
 *
 * Tier assignment lives in compute_jp_refresh_tier() (same migration):
 *   liquidity_score = greatest(snkrdunk max sample_count,
 *                              YAHOO_SAMPLE_WEIGHT x yahoo max sample_count)
 *   hot  = viewed in 30d OR (score >= HOT_SCORE_FLOOR and rank <= HOT_RANK_CAP)
 *   warm = score >= WARM_SCORE_FLOOR and rank <= HOT_RANK_CAP + WARM_RANK_CAP
 *
 * Capacity context (2026-06-12): each source observes ~984 processed
 * cards/day (50/tick hourly minus deadline halts). The hot rank cap bounds
 * daily demand by construction; the smoke test asserts the caps can never
 * outrun a day's tick budget.
 */

/** Multiplier normalizing 1-page Yahoo scrapes vs 4-page Snkrdunk scrapes. */
export const YAHOO_SAMPLE_WEIGHT = 2;

export const JP_HOT_SCORE_FLOOR = 10;
export const JP_WARM_SCORE_FLOOR = 4;
export const JP_HOT_RANK_CAP = 500;
export const JP_WARM_RANK_CAP = 1500;

/**
 * Hours before a priced card is due for re-scrape, per source per tier.
 * `unknown` deliberately equals the pre-tier flat cadence (168h) so an
 * unclassified card behaves exactly as before this change (fail-open).
 *
 * yahoo_jp.hotSnkrdunkCovered: a hot card that also has a CANONICAL RAW
 * Snkrdunk price row gets its daily RAW series from Snkrdunk; Yahoo re-checks
 * at 96h instead of double-scraping the same card daily on both sources.
 * Graded- or per-printing-only Snkrdunk presence does NOT count — the delta
 * math consumes canonical RAW history only.
 *
 * yahoo_jp.sparse (288h = 12d) must stay inside the 14-day jp_display_price
 * median window (migration 20260602040000) or sparse heroes flicker null
 * between refreshes.
 */
export const JP_TIER_CADENCE_HOURS = {
  snkrdunk: {
    hot: 24,
    warm: 72,
    sparse: 168,
    dormant: 720,
    unknown: 168,
  },
  yahoo_jp: {
    hot: 24,
    hotSnkrdunkCovered: 96,
    warm: 96,
    sparse: 288,
    dormant: 720,
    unknown: 168,
  },
};
