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
 *
 * 2026-06 recall batch additions:
 *   - L2 symmetric/variant-normalized name compare (hyphens, ☆/δ/BREAK/ex,
 *     rarity suffixes) + the tag-team guard — the Latias incident ($564
 *     "Latias & Latios GX" mapped onto plain "Latias" via the prefix test)
 *     is pinned as a MUST-NOT-MATCH case
 *   - L3 vintage number formats ("No." prefix, two-part LEGEND numbers,
 *     setCode-only brackets)
 *   - L4 era-table entries (neo, PRMF, VS, web, SC, CP#, M#)
 *   - sister-set guard: single ambiguous set-token hits ("blue") classify
 *     needs-review, never auto-MATCHED
 */
import {
  setCodeEra,
  scoreMatch,
  classifyBest,
  hasDistinctiveSetSignal,
  normalizeNumKeys,
  MIN_MATCH_SCORE,
} from "../match-snkrdunk-canonical.mjs";
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

// =============================================================================
// 2026-06 recall batch
// =============================================================================

console.log();
console.log("--- L4: era-table gap entries (2026-06) ---");
check("neo1 → 1999-2001", JSON.stringify(setCodeEra("neo1")) === "[1999,2001]");
check("neo4 → 1999-2001", JSON.stringify(setCodeEra("neo4")) === "[1999,2001]");
check("neo-P → 1999-2001", JSON.stringify(setCodeEra("neo-P")) === "[1999,2001]");
check("PRMF-1 → 1999-2000", JSON.stringify(setCodeEra("PRMF-1")) === "[1999,2000]");
check("VS → 2001", JSON.stringify(setCodeEra("VS")) === "[2001,2001]");
check("web → 2001", JSON.stringify(setCodeEra("web")) === "[2001,2001]");
check("SC → 2011-2013 (Shiny Collection)", JSON.stringify(setCodeEra("SC")) === "[2011,2013]");
check("SC2 → 2020-2022 (SWSH starter)", JSON.stringify(setCodeEra("SC2")) === "[2020,2022]");
check("SCR (EN Stellar Crown) does NOT hit SC rules", setCodeEra("SCR") === null);
check("CP2 → 2015-2016", JSON.stringify(setCodeEra("CP2")) === "[2015,2016]");
check("CP6 → 2015-2016", JSON.stringify(setCodeEra("CP6")) === "[2015,2016]");
check("MC → 2025-2026 (Start Deck 100 Battle Collection)", JSON.stringify(setCodeEra("MC")) === "[2025,2026]");
check("M-P → 2025-2026 (MEGA promo)", JSON.stringify(setCodeEra("M-P")) === "[2025,2026]");
check("M4 → 2025-2026 (Ninja Spinner)", JSON.stringify(setCodeEra("M4")) === "[2025,2026]");
check("bare M → 2009 (Arceus Random Pack)", JSON.stringify(setCodeEra("M")) === "[2009,2009]");
check("M23 → 2023-2025 (McDonald's)", JSON.stringify(setCodeEra("M23")) === "[2023,2025]");
check("M2a keeps legacy Mega window", JSON.stringify(setCodeEra("M2a")) === "[2024,2026]");
check("additions:false hides new entries (re-score attribution)", setCodeEra("neo1", { additions: false }) === null);
check("additions:false keeps legacy M window", JSON.stringify(setCodeEra("M23", { additions: false })) === "[2024,2026]");

console.log();
console.log("--- L3: vintage number formats ---");
check("No.009 → 9", JSON.stringify(normalizeNumKeys("No.009")) === JSON.stringify(["9"]));
check("074-075/080 → joined + halves", JSON.stringify(normalizeNumKeys("074-075/080")) === JSON.stringify(["74-75", "74", "75"]));
check("037/050 → 37", JSON.stringify(normalizeNumKeys("037/050")) === JSON.stringify(["37"]));
const candNoPrefix = { parsed: parseSnkrdunkProductName('Blastoise: Old Back/PROMO[PMCG-P No.009](PMCG-P Promotional cards)') };
const rNo = scoreMatch(candNoPrefix, { canonical_name: "blastoise", card_number: "9", set_name: "unnumbered promos", year: 1999 });
check("'No.009' number-matches canonical '9'", rNo.reasons.some((r) => r.includes("number-normalized (9)")), rNo.reasons.join(";"));
const candLegend2 = { parsed: parseSnkrdunkProductName('Raikou & Suicune LEGEND: 1ED[L2-L 067-068/080](Expansion Pack "Reviving Legends")') };
const cardLegendHalf = { canonical_name: "raikou & suicune legend", card_number: "67", set_name: "reviving legends", year: 2010 };
const rLeg = scoreMatch(candLegend2, cardLegendHalf);
check("LEGEND half '67' matches '067-068/080'", rLeg.reasons.some((r) => r.includes("number-normalized")), rLeg.reasons.join(";"));
check("LEGEND two-part scores >= threshold", rLeg.score >= MIN_MATCH_SCORE, rLeg.score.toFixed(2));
const rLegJoined = scoreMatch(candLegend2, { ...cardLegendHalf, card_number: "074-075" });
check("LEGEND joined '074-075' does NOT match '067-068'", !rLegJoined.reasons.some((r) => r.includes("number-")));
const rLegJoined2 = scoreMatch(candLegend2, { ...cardLegendHalf, card_number: "067-068" });
check("LEGEND joined '067-068' matches '067-068/080'", rLegJoined2.reasons.some((r) => r.includes("number-normalized")));
const pCodeOnly = parseSnkrdunkProductName('Golem : Old Back [PMCG3](Expansion Pack "Mystery of the Fossils")');
check("setCode-only bracket [PMCG3] parses as setCode", pCodeOnly.setCode === "PMCG3" && pCodeOnly.cardNumber === null, JSON.stringify({ setCode: pCodeOnly.setCode, cardNumber: pCodeOnly.cardNumber }));
const pNumOnly = parseSnkrdunkProductName('Charizard VMAX RR [074/073](Sword & Shield "Champion\'s Path")');
check("number-only bracket still parses as cardNumber", pNumOnly.setCode === null && pNumOnly.cardNumber === "074/073");

console.log();
console.log("--- L2: symmetric/variant-normalized name compare ---");
const cardHyphen = { canonical_name: "Latias-EX", card_number: "53", set_name: "thunder knuckle", year: 2013 };
const candHyphen = { parsed: parseSnkrdunkProductName('Latias EX SR :1ED [BW8 053/051](Expansion Pack "Laiden Knuckle")') };
const rHyphen = scoreMatch(candHyphen, cardHyphen);
check("'Latias-EX' name-matches 'Latias EX SR'", rHyphen.reasons.some((r) => r.includes("name-normalized")), rHyphen.reasons.join(";"));
check("hyphen case crosses threshold", rHyphen.score >= MIN_MATCH_SCORE, rHyphen.score.toFixed(2));
const candWailord = { parsed: parseSnkrdunkProductName('Wailord [PCG4 020/082](Expansion Pack "Rocket Gang Strikes Back")') };
const rWailord = scoreMatch(candWailord, { canonical_name: "Wailord ex", card_number: "20", set_name: "rocket gang strikes back", year: 2004 });
check("'Wailord ex' variant-matches product 'Wailord'", rWailord.reasons.some((r) => r.includes("name-variant-normalized")), rWailord.reasons.join(";"));
const candDelta = { parsed: parseSnkrdunkProductName('Mightyena Delta Species R: 1ED[PCG6 042/086](Expansion Pack "Holon Research Tower")') };
const rDelta = scoreMatch(candDelta, { canonical_name: "Mightyena δ", card_number: "42", set_name: "holon research tower", year: 2005 });
check("'Mightyena δ' variant-matches 'Mightyena Delta Species R'", rDelta.reasons.some((r) => r.includes("name-variant-normalized")), rDelta.reasons.join(";"));
check("delta case crosses threshold", rDelta.score >= MIN_MATCH_SCORE, rDelta.score.toFixed(2));
const candStar = { parsed: parseSnkrdunkProductName('Latios Star [PCG9 065/068](Expansion Pack "Clash of the Blue Sky")') };
const rStar = scoreMatch(candStar, { canonical_name: "Latios ☆", card_number: "65", set_name: "clash of the blue sky", year: 2004 });
check("'Latios ☆' name-matches 'Latios Star'", rStar.reasons.some((r) => r.includes("name-normalized")), rStar.reasons.join(";"));
const candBreakless = { parsed: parseSnkrdunkProductName('Florges [XY8 043/059](Expansion Pack "Blue Impact")') };
const rBreakless = scoreMatch(candBreakless, { canonical_name: "Florges BREAK", card_number: "43", set_name: "blue shock", year: 2015 });
check("'Florges BREAK' variant-matches product 'Florges'", rBreakless.reasons.some((r) => r.includes("name-variant-normalized")), rBreakless.reasons.join(";"));
check("variant credit (0.25) stays below exact-prefix credit (0.30)", !rBreakless.reasons.some((r) => r.startsWith("+0.30 name-variant")) && rBreakless.reasons.some((r) => r.startsWith("+0.25 name-variant")));
// "MEGA Latias ex SAR" vs plain "Latias": legacy containment (+0.20) is
// pre-existing behavior; the NEW normalized paths must not upgrade it to
// +0.25/+0.30 (front residue ≠ variant suffix — prefix semantics).
const rMega = scoreMatch({ parsed: parseSnkrdunkProductName('MEGA Latias ex SAR [M1S 088/063](Expansion Pack "Mega Symphonia")') }, { canonical_name: "Latias", card_number: "88", set_name: "x", year: 2026 });
check("'MEGA Latias ex' never gains normalized/variant name credit", !rMega.reasons.some((r) => r.includes("name-normalized") || r.includes("name-variant")), rMega.reasons.join(";"));
check("'MEGA Latias ex' stays at legacy containment credit", rMega.reasons.some((r) => r.startsWith("+0.20 name-contained")));

console.log();
console.log("--- L2 guard: THE LATIAS INCIDENT (tag team must NOT match single) ---");
// 2026-05: a $564 "Latias & Latios GX" was mapped onto plain "Latias" because
// "latias & latios gx".startsWith("latias ") passed the prefix test and the
// number coincided. Worst case pinned here: number AND set AND era all
// coincide — the pair must STILL fail the threshold.
const candTagTeam = { parsed: parseSnkrdunkProductName('Latias & Latios GX SR [SM9 104/095](Expansion Pack "Tag Bolt")') };
const cardSingle = { canonical_name: "Latias", card_number: "104", set_name: "Tag Bolt", year: 2018 };
const rIncident = scoreMatch(candTagTeam, cardSingle);
check("no positive name credit", !rIncident.reasons.some((r) => r.includes("name-")), rIncident.reasons.join(";"));
check("multi-pokemon-mismatch penalty fires", rIncident.reasons.some((r) => r.includes("multi-pokemon-mismatch")));
check("score < threshold (MUST NOT MATCH)", rIncident.score < MIN_MATCH_SCORE, rIncident.score.toFixed(2));
check("classifies low-confidence", classifyBest({ score: rIncident.score, setTokenHits: rIncident.setTokenHits }) === "low-confidence");
const rIncidentRev = scoreMatch({ parsed: parseSnkrdunkProductName('Latias [L-P 045](Promotional Card "Heart Gold Collection")') }, { canonical_name: "Latias & Latios-GX", card_number: "45", set_name: "tag bolt", year: 2018 });
check("reverse direction (tag-team canonical vs single product) also fails", !rIncidentRev.reasons.some((r) => r.includes("name-")) && rIncidentRev.reasons.some((r) => r.includes("multi-pokemon-mismatch")));
const rTagBoth = scoreMatch(candTagTeam, { canonical_name: "Latias & Latios-GX", card_number: "104", set_name: "Tag Bolt", year: 2018 });
check("tag team on BOTH sides still matches", rTagBoth.reasons.some((r) => r.includes("name-")) && rTagBoth.score >= MIN_MATCH_SCORE, `${rTagBoth.score.toFixed(2)} ${rTagBoth.reasons.join(";")}`);

console.log();
console.log("--- sister-set guard: single ambiguous token never auto-promotes ---");
check("['blue'] is not distinctive", hasDistinctiveSetSignal(["blue"]) === false);
check("['blue','shock'] is distinctive (2 hits)", hasDistinctiveSetSignal(["blue", "shock"]) === true);
check("['knuckle'] is distinctive (unique token)", hasDistinctiveSetSignal(["knuckle"]) === true);
check("[] is not distinctive", hasDistinctiveSetSignal([]) === false);
// Florges XY8: PopAlpha set_name "Blue Shock", Snkrdunk translates the same
// JP set as "Blue Impact" — only the ambiguous token "blue" overlaps, which
// also hits "Blue Sky Stream" (2021) / "Clash of the Blue Sky" (2004).
const candFlorges = { parsed: parseSnkrdunkProductName('Florges BREAK [XY8 043/059](Expansion Pack "Blue Impact")') };
const cardFlorges = { canonical_name: "Florges BREAK", card_number: "43", set_name: "Blue Shock", year: 2015 };
const rFlorges = scoreMatch(candFlorges, cardFlorges);
check("Florges sister-set scores >= threshold", rFlorges.score >= MIN_MATCH_SCORE, rFlorges.score.toFixed(2));
check("…but classifies needs-review (no auto-promote)", classifyBest({ score: rFlorges.score, setTokenHits: rFlorges.setTokenHits }) === "needs-review", JSON.stringify(rFlorges.setTokenHits));
// Two distinctive tokens still auto-promote (Wild Blaze regression guard).
const candWildBlaze = { parsed: parseSnkrdunkProductName('Florges R [XY2 053/080](Expansion Pack "Wild Blaze")') };
const rWildBlaze = scoreMatch(candWildBlaze, { canonical_name: "Florges", card_number: "53", set_name: "wild blaze", year: 2014 });
check("two-token set evidence still auto-promotes", classifyBest({ score: rWildBlaze.score, setTokenHits: rWildBlaze.setTokenHits }) === "matched", JSON.stringify(rWildBlaze.setTokenHits));

console.log();
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
