#!/usr/bin/env node
/**
 * Smoke test for lib/jp/matcher.mjs's card-number mismatch filter.
 *
 * Exercises extractTitleNumberFractions(), shouldExcludeForNumberMismatch(),
 * the shared titleMatchesCardNumber() helper, and the selectMatched()
 * aggregation boundary without hitting Yahoo!. Designed to be cheap
 * (<1s, no network) so PRs touching the matcher can re-run it:
 *
 *   node scripts/__smoke__/yahoo-number-mismatch-filter.mjs
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 *
 * Why this exists: buildPrecisionQuery searches name+set with no card
 * number, so every same-name slug in a set pooled the SAME sold listings
 * (MEGA Dream ex "Mega Dragonite ex" #126 RR / #232 MA / #246 SAR / #250
 * MUR all carried one identical blended median — 1,019 fan-out groups /
 * 2,275 slugs). These tests pin the negative number-mismatch filter:
 *   - listing with a matching number is kept
 *   - listing with a mismatching parseable number is dropped
 *   - listing with no parseable number is kept (unchanged behavior)
 *   - full-width digits/slash are outside the shared ASCII extraction
 *     tolerance -> not parseable -> kept
 *   - card with no/non-numeric card_number -> no filtering at all
 *   - date chains ("2026/05/10"), sale deadlines ("10/30まで"), and
 *     condition scores ("10/10") never parse as card numbers
 *   - selectMatched reports numberMismatchExcluded and both the
 *     per-printing and canonical-rollup observations exclude the
 *     dropped listing (MIN_SAMPLE floors then apply to the honest n)
 */
import {
  baseCardNumber,
  titleMatchesCardNumber,
  extractTitleNumberFractions,
  shouldExcludeForNumberMismatch,
  scoreListing,
  selectMatched,
} from "../../lib/jp/matcher.mjs";

let fails = 0;
function check(label, cond, detail) {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) fails++;
  console.log(`  ${tag} | ${label}${detail ? "  -- " + detail : ""}`);
}

console.log("--- extractTitleNumberFractions: tolerance + guards ---");
const extractionCases = [
  // [label, title, expected fractions as "num/den" strings]
  ["plain fraction", "メガカイリューex RR 126/193 美品", ["126/193"]],
  ["secret rare above set total", "メガカイリューex SAR 246/193", ["246/193"]],
  ["two fractions both parse", "メガカイリューex 126/193 232/193", ["126/193", "232/193"]],
  ["full-width digits not parseable", "メガカイリューex ＳＡＲ ２４６／１９３", []],
  ["full-width slash not parseable", "メガカイリューex SAR 246／193", []],
  ["date chain blocked by slash boundary", "2026/05/10入手 メガカイリューex", []],
  ["sale deadline under set-total floor", "メガカイリューex 10/30まで値下げ", []],
  ["condition score under set-total floor", "メガカイリューex 美品 10/10", []],
  ["embedded digit run blocked", "シリアル1246/193のカード", []],
  ["zero-padded numerator parses", "メガカイリューex 026/070", ["26/70"]],
  ["title with no digits", "メガカイリューex 極美品", []],
];
for (const [label, title, expected] of extractionCases) {
  const got = extractTitleNumberFractions(title).map((f) => `${f.numerator}/${f.denominator}`);
  check(label, JSON.stringify(got) === JSON.stringify(expected), `got [${got.join(", ")}]`);
}

console.log();
console.log("--- shouldExcludeForNumberMismatch: keep/drop table ---");
const filterCases = [
  // [label, title, card_number, expectExcluded]
  ["matching number kept", "メガカイリューex RR 126/193", "126", false],
  ["mismatching number dropped", "メガカイリューex SAR 246/193", "126", true],
  ["mismatch in the other direction dropped", "メガカイリューex RR 126/193", "246", true],
  ["no parseable number kept", "メガカイリューex 極美品", "126", false],
  ["bare matching number kept (scorer parity)", "メガカイリューex 126", "126", false],
  ["full-width digits -> not parseable -> kept", "メガカイリューex ＳＡＲ ２４６／１９３", "126", false],
  ["full-width slash -> not parseable -> kept", "メガカイリューex SAR 246／193", "126", false],
  ["date chain kept", "2026/05/10入手 メガカイリューex", "126", false],
  ["sale deadline kept", "メガカイリューex 10/30まで値下げ", "126", false],
  ["condition score kept", "メガカイリューex 美品 10/10", "126", false],
  ["zero-padded title matches numerically", "メガカイリューex 026/070", "26", false],
  ["own secret-rare number kept", "メガカイリューex SAR 246/193", "246", false],
  ["mismatch among multiple fractions, one matches -> kept", "メガカイリューex 126/193 232/193", "126", false],
  ["null card_number never filters", "メガカイリューex SAR 246/193", null, false],
  ["empty card_number never filters", "メガカイリューex SAR 246/193", "", false],
  ["non-numeric card_number never filters", "メガカイリューex SAR 246/193", "TG12", false],
  ["suffixed card_number uses base number", "メガカイリューex SAR 246/193", "126-holo", true],
];
for (const [label, title, cardNumber, expectExcluded] of filterCases) {
  const got = shouldExcludeForNumberMismatch(title, cardNumber);
  check(label, got === expectExcluded, `excluded=${got}`);
}

console.log();
console.log("--- scorer/filter consistency on the shared helper ---");
check("baseCardNumber strips -suffix", baseCardNumber("126-holo") === "126");
check("baseCardNumber null on empty", baseCardNumber("  ") === null);
check("titleMatchesCardNumber allows /set-total", titleMatchesCardNumber("メガカイリューex 126/193", "126") === true);
check("titleMatchesCardNumber blocks digit-run", titleMatchesCardNumber("シリアル1126のカード", "126") === false);
const scoredKept = scoreListing(
  { title: "メガドリームex メガカイリューex 126/193", price: 2500 },
  { canonical_name: "Mega Dragonite ex", canonical_name_native: "メガカイリューex", set_name: "MEGA Dream ex", set_name_native: "メガドリームex", card_number: "126" },
);
check(
  "scoreListing +0.15 number bonus survives the refactor",
  scoredKept.reasons.some((r) => r.startsWith("+0.15 has-card-number (126)")),
  scoredKept.reasons.join(" | "),
);
check(
  "any scorer-credited listing is never filter-dropped",
  shouldExcludeForNumberMismatch("メガドリームex メガカイリューex 126/193", "126") === false,
);

console.log();
console.log("--- selectMatched: counter + canonical rollup respect the filter ---");
const megaDragoniteRR = {
  slug: "mega-dream-ex-mega-dragonite-ex-126-jp",
  canonical_name: "Mega Dragonite ex",
  canonical_name_native: "メガカイリューex",
  set_name: "MEGA Dream ex",
  set_name_native: "メガドリームex",
  card_number: "126",
  year: 2025,
  language: "JP",
};
// name (+0.30) + set (+0.20) clears minScore 0.50; the SAR listing's
// 246/193 then gets dropped at the aggregation boundary, not by score.
const listings = [
  { title: "ポケモンカード メガドリームex メガカイリューex RR 126/193 美品", price: 2500 },
  { title: "ポケモンカード メガドリームex メガカイリューex SAR 246/193 極美品", price: 28000 },
  { title: "ポケモンカード メガドリームex メガカイリューex", price: 2400 },
];
const r1 = selectMatched(listings, megaDragoniteRR);
check("counter increments once", r1.numberMismatchExcluded === 1, `got ${r1.numberMismatchExcluded}`);
check("accepted shrinks to 2", r1.accepted === 2, `got ${r1.accepted}`);
const rollup1 = r1.priceObservations.find((o) => o.grade === "RAW" && o.printing_id === null);
check("rollup n excludes the SAR listing", rollup1?.count === 2, `got ${rollup1?.count}`);
check("rollup median is the honest RR price", rollup1?.median === 2500, `got ${rollup1?.median}`);

const noNumberCard = { ...megaDragoniteRR, card_number: null };
const r2 = selectMatched(listings, noNumberCard);
check("unknown card_number -> counter stays 0", r2.numberMismatchExcluded === 0, `got ${r2.numberMismatchExcluded}`);
const rollup2 = r2.priceObservations.find((o) => o.grade === "RAW" && o.printing_id === null);
check("unknown card_number -> pool unchanged (n=3)", rollup2?.count === 3, `got ${rollup2?.count}`);

console.log();
console.log("--- selectMatched: per-printing aggregation respects the filter ---");
const holoListings = [
  { title: "ポケモンカード メガドリームex メガカイリューex 126/193 ホロ", price: 3000 },
  { title: "ポケモンカード メガドリームex メガカイリューex 246/193 ホロ", price: 30000 },
  { title: "ポケモンカード メガドリームex メガカイリューex ホロ 美品", price: 3200 },
];
const printings = [
  { id: "printing-holo", finish: "HOLO" },
  { id: "printing-nonholo", finish: "NON_HOLO" },
];
const r3 = selectMatched(holoListings, megaDragoniteRR, { printings });
check("per-printing run counter increments", r3.numberMismatchExcluded === 1, `got ${r3.numberMismatchExcluded}`);
const perPrinting = r3.priceObservations.find((o) => o.grade === "RAW" && o.printing_id === "printing-holo");
check("HOLO per-printing n excludes the mismatch", perPrinting?.count === 2, `got ${perPrinting?.count}`);
const rollup3 = r3.priceObservations.find((o) => o.grade === "RAW" && o.printing_id === null);
check("canonical rollup n excludes the mismatch", rollup3?.count === 2, `got ${rollup3?.count}`);
check(
  "MIN_SAMPLE floors see the post-filter n (caller-side count is the honest 2, not 3)",
  (rollup3?.count ?? 0) < holoListings.length,
);

console.log();
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
