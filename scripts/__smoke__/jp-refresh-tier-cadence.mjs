/**
 * Smoke: JP tiered-refresh cadence invariants.
 *
 * Pattern follows scripts/__smoke__/snkrdunk-matcher-scoring.mjs: <1s, no
 * network, exit 1 on failure. Guards the constants in
 * lib/jp/refresh-cadence.mjs (the documented mirror of the SQL cadence in
 * supabase/migrations/20260613120000_jp_refresh_tier_cadence.sql) against
 * edits that would silently break the capacity or freshness math.
 */

import {
  JP_TIER_CADENCE_HOURS,
  JP_HOT_RANK_CAP,
  JP_WARM_RANK_CAP,
  JP_HOT_SCORE_FLOOR,
  JP_WARM_SCORE_FLOOR,
  JP_SNK_OWNERSHIP_FRESHNESS_HOURS,
} from "../../lib/jp/refresh-cadence.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

const snk = JP_TIER_CADENCE_HOURS.snkrdunk;
const yah = JP_TIER_CADENCE_HOURS.yahoo_jp;

// Cadence monotonic per source: hotter tiers refresh at least as often.
check(
  "snkrdunk cadence monotonic (hot <= warm <= sparse <= dormant)",
  snk.hot <= snk.warm && snk.warm <= snk.sparse && snk.sparse <= snk.dormant,
);
check(
  "yahoo cadence monotonic (hot <= warm <= sparse <= dormant)",
  yah.hot <= yah.warm && yah.warm <= yah.sparse && yah.sparse <= yah.dormant,
);
check(
  "yahoo snkrdunk-covered hot sits between hot and sparse",
  yah.hot <= yah.hotSnkrdunkCovered && yah.hotSnkrdunkCovered <= yah.sparse,
);

// Hot must be daily on at least one source or 24h pairs never form.
check("hot = 24h on at least one source", snk.hot === 24 || yah.hot === 24);

// 24h-pair feasibility: compute_jp_card_price_changes (20260520140000) needs
// a baseline in [now-72h, now-12h] plus a latest row <72h. A daily cadence
// satisfies that; anything over 60h cannot reliably produce a 24h pair.
check("hot cadence can actually produce 24h pairs (<= 60h)", Math.min(snk.hot, yah.hot) <= 60);

// Fail-open guard: an unclassified card must not refresh more aggressively
// than warm (unknown is the whole-catalog default — if it were hot-like, a
// recompute outage would stampede the scrapers).
check("snkrdunk unknown >= warm cadence (fail-open)", snk.unknown >= snk.warm);
check("yahoo unknown >= warm cadence (fail-open)", yah.unknown >= yah.warm);

// Freshness ceiling: yahoo sparse must stay inside the 14-day
// jp_display_price median window (20260602040000) with >= 1 day of margin,
// or sparse heroes flicker null between refreshes.
check("yahoo sparse cadence <= 13 days (display median window)", yah.sparse <= 13 * 24);
check("snkrdunk sparse cadence <= 13 days (display median window)", snk.sparse <= 13 * 24);

// Capacity: the rank caps bound daily refresh demand; they must never
// outrun 90% of a full day's tick budget (50 cards x 24 ticks) per source,
// even before initial-coverage takes its share.
const DAILY_TICK_BUDGET = 50 * 24;
const hotDaily = JP_HOT_RANK_CAP / (Math.min(snk.hot, yah.hot) / 24);
const warmDaily = JP_WARM_RANK_CAP / (Math.min(snk.warm, yah.warm) / 24);
check(
  "hot + warm caps fit inside 90% of a day's tick budget",
  hotDaily + warmDaily <= 0.9 * DAILY_TICK_BUDGET,
);

// Snkrdunk-ownership freshness window: must comfortably exceed the snkrdunk
// hot cadence (or healthy daily ownership flaps Yahoo back to daily), and must
// not exceed the snkrdunk-covered Yahoo cadence (or a dead snkrdunk series
// could go unnoticed longer than Yahoo's own re-check).
check(
  "snk ownership freshness >= 2x snkrdunk hot cadence",
  JP_SNK_OWNERSHIP_FRESHNESS_HOURS >= 2 * snk.hot,
);
check(
  "snk ownership freshness <= snkrdunk-covered yahoo cadence",
  JP_SNK_OWNERSHIP_FRESHNESS_HOURS <= yah.hotSnkrdunkCovered,
);

// Sanity on the assignment knobs.
check("hot score floor > warm score floor", JP_HOT_SCORE_FLOOR > JP_WARM_SCORE_FLOOR);
check("rank caps positive", JP_HOT_RANK_CAP > 0 && JP_WARM_RANK_CAP > 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\njp-refresh-tier-cadence smoke passed");
