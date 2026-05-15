#!/usr/bin/env node
/**
 * Smoke test for scripts/match-snkrdunk-canonical.mjs scoring rules.
 *
 * Exercises setCodeEra() and scoreMatch() without hitting the Snkrdunk
 * API. Designed to be cheap (<1s, no network) so PRs touching the
 * matcher can re-run it:
 *
 *   node scripts/__smoke__/snkrdunk-matcher-scoring.mjs
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 *
 * Cases covered:
 *   - setCodeEra mapping coverage across vintage / mid / modern setCodes
 *   - era-match grants +0.15 when canonical.year aligns with setCode era
 *   - era-mismatch deducts -0.30 in BOTH directions (vintage→modern AND
 *     modern→vintage / Legend reprint cases)
 *   - SET_TOKEN_STOPWORDS strips leaky generic tokens (game, classic,
 *     pocket, monster, series, etc.) so they no longer grant set-token
 *     credit
 *   - year=null and unknown setCode are no-ops (don't add or subtract)
 *
 * Why this exists: post-PR #71 era audit found ~187 wrong-era matches
 * that scored above MIN_MATCH_SCORE because the previous rules only
 * caught vintage→modern. These tests pin the symmetric replacement so
 * the regression can't return silently.
 */
import { setCodeEra, scoreMatch } from "../match-snkrdunk-canonical.mjs";
import { parseSnkrdunkProductName } from "../../lib/jp/snkrdunk-matcher.mjs";

let fails = 0;
function check(label, cond, detail) {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) fails++;
  console.log(`  ${tag} | ${label}${detail ? "  -- " + detail : ""}`);
}

console.log("--- setCodeEra coverage ---");
check("PMCG → vintage", JSON.stringify(setCodeEra("PMCG1")) === "[1996,2000]");
check("SV → modern", JSON.stringify(setCodeEra("SV4a")) === "[2023,2026]");
check("SM → 2017-2019", JSON.stringify(setCodeEra("SM12a")) === "[2017,2019]");
check("XY → 2013-2016", JSON.stringify(setCodeEra("XY9")) === "[2013,2016]");
check("L1-S → 2010-2011", JSON.stringify(setCodeEra("L1-S")) === "[2010,2011]");
check("S-P → 2020-2023", JSON.stringify(setCodeEra("S-P")) === "[2020,2023]");
check("SM-P → 2017-2019", JSON.stringify(setCodeEra("SM-P")) === "[2017,2019]");
check("M1L → 2025-2026", JSON.stringify(setCodeEra("M1L")) === "[2025,2026]");
check("null on unknown", setCodeEra("XXXX") === null);
check("null on empty", setCodeEra("") === null);

console.log();
console.log("--- scoreMatch: era-match adds +0.15 ---");
const candModern = { parsed: parseSnkrdunkProductName("Mr. Mime [SV4a 031](Cyber Judge)") };
const cardModern = { canonical_name: "mr. mime", card_number: "31", set_name: "cyber judge", year: 2024 };
const r1 = scoreMatch(candModern, cardModern);
check("modern→modern includes era-match", r1.reasons.some((r) => r.startsWith("+0.15 era-match")));
check("modern→modern score >= 0.55", r1.score >= 0.55);

console.log();
console.log("--- scoreMatch: era-mismatch penalizes -0.30 (vintage→modern) ---");
const candWrong = { parsed: parseSnkrdunkProductName("Voltorb [SV2a 100/165](Pokemon Card 151)") };
const cardVintage = { canonical_name: "voltorb", card_number: "100", set_name: "topsun", year: 1995 };
const r2 = scoreMatch(candWrong, cardVintage);
check("vintage→modern includes era-mismatch", r2.reasons.some((r) => r.startsWith("-0.30 era-mismatch")));
check("vintage→modern score < 0.55 (rejects)", r2.score < 0.55);

console.log();
console.log("--- scoreMatch: inverse-direction mismatch (2017 canonical → Legend reprint) ---");
const candLegend = { parsed: parseSnkrdunkProductName("Wailord [L1-S 011](Legend HeartGold)") };
const cardSm = { canonical_name: "wailord", card_number: "11", set_name: "alolan moonlight", year: 2017 };
const r3 = scoreMatch(candLegend, cardSm);
check("2017→Legend includes era-mismatch", r3.reasons.some((r) => r.startsWith("-0.30 era-mismatch")));
check("2017→Legend score < 0.55 (rejects)", r3.score < 0.55);

console.log();
console.log("--- scoreMatch: SM-era canonical matches SM-era candidate ---");
const candSm = { parsed: parseSnkrdunkProductName("Wailord [SM3+ 011/049](Burning Shadows)") };
const r4 = scoreMatch(candSm, cardSm);
check("2017→SM includes era-match", r4.reasons.some((r) => r.startsWith("+0.15 era-match")));

console.log();
console.log("--- SET_TOKEN_STOPWORDS: leaky tokens no longer grant credit ---");
const candStop = { parsed: parseSnkrdunkProductName("Charizard [SV1a 011/078](Classic Game Pocket Monster Series)") };
const cardSv = { canonical_name: "charizard", card_number: "11", set_name: "classic game pocket monster", year: 2024 };
const r5 = scoreMatch(candStop, cardSv);
check(
  "no set-tokens credited (all tokens are stopwords)",
  !r5.reasons.some((r) => r.startsWith("+0") && r.includes("set-tokens")),
);

console.log();
console.log("--- canonical.year null no-op ---");
const candNullYear = { parsed: parseSnkrdunkProductName("Charizard [SV1a 011/078](Triplet Beat)") };
const cardNullYear = { canonical_name: "charizard", card_number: "11", set_name: "triplet beat", year: null };
const r6 = scoreMatch(candNullYear, cardNullYear);
check("no era bump or penalty when year null", !r6.reasons.some((r) => r.includes("era-")));

console.log();
console.log("--- unknown setCode no-op (preserves backward-compat) ---");
const candUnknown = { parsed: parseSnkrdunkProductName("Charizard [ZZZ9 011](Unknown Set)") };
const r7 = scoreMatch(candUnknown, cardSv);
check("no era bump or penalty when setCode unmapped", !r7.reasons.some((r) => r.includes("era-")));

console.log();
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
