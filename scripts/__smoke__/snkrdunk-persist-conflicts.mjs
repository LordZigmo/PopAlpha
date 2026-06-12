#!/usr/bin/env node
/**
 * Smoke test for scripts/persist-snkrdunk-matches.mjs conflict + idempotency
 * decision helpers. No network, no DB, <1s:
 *
 *   node scripts/__smoke__/snkrdunk-persist-conflicts.mjs
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 *
 * Why this exists: the 2026-05-14 seeding run silently DROPPED 337 of 8,123
 * persistable rows on snkrdunk_product_code unique violations (6,451 matched
 * + 1,672 needs-review vs 7,786 persisted). The 2026-06 recall batch replaces
 * drop-on-conflict with:
 *   - winner = higher score (tie: better number match, then slug order)
 *   - loser  = persisted as NEEDS_REVIEW with a conflict note
 *   - idempotent re-persist: reviewed/REJECTED/MATCHED rows immutable,
 *     NR→MATCHED upgrades allowed, NR→NR skipped
 * These tests pin that decision table.
 */
import {
  numberMatchRank,
  resolveProductCodeConflicts,
  decideWrite,
} from "../persist-snkrdunk-matches.mjs";

let fails = 0;
function check(label, cond, detail) {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) fails++;
  console.log(`  ${tag} | ${label}${detail ? "  -- " + detail : ""}`);
}

console.log("--- numberMatchRank ---");
check("number-exact → 2", numberMatchRank(["+0.30 name-exact", "+0.30 number-exact"]) === 2);
check("number-normalized → 1", numberMatchRank(["+0.30 number-normalized (76)"]) === 1);
check("no number reason → 0", numberMatchRank(["+0.30 name-exact"]) === 0);
check("null reasons → 0", numberMatchRank(null) === 0);

console.log();
console.log("--- resolveProductCodeConflicts: higher score wins ---");
const e = (slug, code, score, reasons = []) => ({ canonical_slug: slug, best: { snkrdunk_product_code: code, score, reasons } });
const d1 = resolveProductCodeConflicts([
  e("slug-a", "SW---1", 0.85),
  e("slug-b", "SW---1", 0.70),
  e("slug-c", "SW---2", 0.60),
]);
check("loser demoted", d1.has("slug-b") && !d1.has("slug-a"), JSON.stringify([...d1.keys()]));
check("uncontested code untouched", !d1.has("slug-c"));
check("demotion records winner", d1.get("slug-b")?.winnerSlug === "slug-a" && d1.get("slug-b")?.winnerScore === 0.85);

console.log();
console.log("--- resolveProductCodeConflicts: score tie → better number match wins ---");
const d2 = resolveProductCodeConflicts([
  e("slug-norm", "SW---9", 0.75, ["+0.30 number-normalized (45)"]),
  e("slug-exact", "SW---9", 0.75, ["+0.30 number-exact"]),
]);
check("number-exact beats number-normalized on tie", d2.has("slug-norm") && !d2.has("slug-exact"), JSON.stringify([...d2.keys()]));

console.log();
console.log("--- resolveProductCodeConflicts: full tie → deterministic slug order ---");
const d3a = resolveProductCodeConflicts([e("slug-z", "SW---3", 0.6), e("slug-a", "SW---3", 0.6)]);
const d3b = resolveProductCodeConflicts([e("slug-a", "SW---3", 0.6), e("slug-z", "SW---3", 0.6)]);
check("same loser regardless of input order", d3a.has("slug-z") && d3b.has("slug-z") && !d3a.has("slug-a") && !d3b.has("slug-a"));

console.log();
console.log("--- resolveProductCodeConflicts: three-way pile-up keeps exactly one winner ---");
const d4 = resolveProductCodeConflicts([
  e("s1", "SW---7", 0.55),
  e("s2", "SW---7", 0.95),
  e("s3", "SW---7", 0.75),
]);
check("two losers, one winner", d4.size === 2 && d4.has("s1") && d4.has("s3") && !d4.has("s2"));

console.log();
console.log("--- decideWrite: idempotent re-persist rules ---");
check("no existing row → write", decideWrite(null, "MATCHED").action === "write");
check("reviewed row immutable", decideWrite({ mapping_status: "NEEDS_REVIEW", reviewed_at: "2026-05-20T00:00:00Z" }, "MATCHED").why === "reviewed-immutable");
check("REJECTED immutable (even unreviewed)", decideWrite({ mapping_status: "REJECTED", reviewed_at: null }, "MATCHED").why === "rejected-immutable");
check("MATCHED never downgraded/touched", decideWrite({ mapping_status: "MATCHED", reviewed_at: null }, "NEEDS_REVIEW").why === "matched-immutable");
check("MATCHED not re-written even by MATCHED", decideWrite({ mapping_status: "MATCHED", reviewed_at: null }, "MATCHED").action === "skip");
check("NR → MATCHED upgrade allowed", decideWrite({ mapping_status: "NEEDS_REVIEW", reviewed_at: null }, "MATCHED").why === "upgrade-nr-to-matched");
check("NR → NR skipped (no improvement)", decideWrite({ mapping_status: "NEEDS_REVIEW", reviewed_at: null }, "NEEDS_REVIEW").why === "no-improvement");
check("force-status overrides guards (operator-only)", decideWrite({ mapping_status: "MATCHED", reviewed_at: "2026-05-20T00:00:00Z" }, "NEEDS_REVIEW", { forceStatus: true }).action === "write");

console.log();
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
