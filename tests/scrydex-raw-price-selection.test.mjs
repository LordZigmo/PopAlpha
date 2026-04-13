import assert from "node:assert/strict";
import { selectPreferredScrydexPriceEntry, selectScrydexGradedEntries } from "../lib/backfill/scrydex-raw-price-select.ts";

// Regression fixtures for the Legends Awakened Dratini contamination: Scrydex
// was returning mixed raw + graded rows in a single `prices` array, and the
// daily normalize was falling through to graded (PSA 10) entries whenever the
// raw NM row lacked a populated market/low field. The selector must:
//   1. Pick raw NM over everything else when both exist
//   2. Never return graded rows even if they have the only populated prices
//   3. Never return non-NM/Mint raw rows (LP/MP/HP/damaged)
//   4. Return null when no qualifying raw NM/Mint row exists

function runScrydexRawPriceSelectionTests() {
  // 1. Mixed array — raw NM must win over graded and raw LP.
  const mixed = [
    { type: "graded", condition: "Gem Mint", grade: "10", company: "PSA", market: 157.0 },
    { type: "graded", condition: "Mint", grade: "9", company: "PSA", market: 20.5 },
    { type: "raw", condition: "Near Mint", market: 3.06, low: 2.8, mid: 3.0, high: 3.5 },
    { type: "raw", condition: "Lightly Played", market: 2.1, low: 1.9 },
  ];
  const mixedPick = selectPreferredScrydexPriceEntry(mixed);
  assert.ok(mixedPick, "mixed array must produce a selection");
  assert.equal(mixedPick.price, 3.06, "must pick raw NM market, not graded");
  assert.equal(mixedPick.normalizedCondition, "nm");

  // 2. Only graded rows — must return null, never substitute $157.
  const gradedOnly = [
    { type: "graded", condition: "Gem Mint", grade: "10", company: "PSA", market: 157.0 },
    { type: "graded", condition: "Mint", grade: "9", company: "PSA", market: 20.5 },
    { type: "graded", condition: "Mint", grade: "8", company: "PSA", market: 8.0 },
  ];
  assert.equal(selectPreferredScrydexPriceEntry(gradedOnly), null, "graded-only must return null");

  // 3. Raw but only LP/MP/HP — must return null.
  const nonNearMint = [
    { type: "raw", condition: "Lightly Played", market: 2.1 },
    { type: "raw", condition: "Moderately Played", market: 1.5 },
    { type: "raw", condition: "Heavily Played", market: 0.9 },
  ];
  assert.equal(selectPreferredScrydexPriceEntry(nonNearMint), null, "raw non-NM must return null");

  // 4. Raw NM with no price fields populated — must return null, NOT fall
  //    through to a lower-priority row. This is the exact failure mode behind
  //    the Dratini $157 bug: raw NM exists but is price-empty, graded has a
  //    market, the old selector returned the graded one.
  const rawNmEmpty = [
    { type: "raw", condition: "Near Mint", market: null, low: null, mid: null, high: null },
    { type: "graded", condition: "Gem Mint", grade: "10", company: "PSA", market: 157.0 },
  ];
  assert.equal(selectPreferredScrydexPriceEntry(rawNmEmpty), null, "empty raw NM must not fall through to graded");

  // 5. Missing `condition` field on a graded row must NOT be defaulted to NM.
  //    (The old normalizeScrydexCondition default of "nm" was a second
  //    contamination vector — a graded row with an absent condition would
  //    sneak past the downstream `shouldWriteRawForCondition` filter.)
  const gradedMissingCondition = [
    { type: "graded", grade: "10", company: "PSA", market: 157.0 },
  ];
  assert.equal(selectPreferredScrydexPriceEntry(gradedMissingCondition), null, "missing condition must not default to NM");

  // 6. Excluded flags — signed/perfect/error rows must be rejected even if raw NM.
  const flagged = [
    { type: "raw", condition: "Near Mint", is_signed: true, market: 500.0 },
    { type: "raw", condition: "Near Mint", is_perfect: true, market: 400.0 },
    { type: "raw", condition: "Near Mint", is_error: true, market: 300.0 },
    { type: "raw", condition: "Near Mint", market: 3.06 },
  ];
  const flaggedPick = selectPreferredScrydexPriceEntry(flagged);
  assert.ok(flaggedPick);
  assert.equal(flaggedPick.price, 3.06, "must reject signed/perfect/error rows");

  // 7. Mint condition is accepted (treated as raw NM-equivalent), but scored
  //    below NM when both are present.
  const nmAndMint = [
    { type: "raw", condition: "Mint", market: 5.0 },
    { type: "raw", condition: "Near Mint", market: 3.0 },
  ];
  const nmWins = selectPreferredScrydexPriceEntry(nmAndMint);
  assert.ok(nmWins);
  assert.equal(nmWins.price, 3.0, "NM must outscore Mint when both present");

  const mintOnly = [
    { type: "raw", condition: "Mint", market: 5.0 },
  ];
  const mintPick = selectPreferredScrydexPriceEntry(mintOnly);
  assert.ok(mintPick);
  assert.equal(mintPick.price, 5.0, "Mint alone is acceptable");

  // 8. Untyped row with NM condition is accepted (tolerate missing `type` as
  //    long as it's not explicitly "graded"). Price fields must still exist.
  const untyped = [
    { condition: "Near Mint", market: 2.5 },
  ];
  const untypedPick = selectPreferredScrydexPriceEntry(untyped);
  assert.ok(untypedPick);
  assert.equal(untypedPick.price, 2.5);

  // 9. Empty / null / missing inputs must return null without throwing.
  assert.equal(selectPreferredScrydexPriceEntry(null), null);
  assert.equal(selectPreferredScrydexPriceEntry(undefined), null);
  assert.equal(selectPreferredScrydexPriceEntry([]), null);
  assert.equal(selectPreferredScrydexPriceEntry({}), null);

  // 10. Single-object form (not wrapped in an array) is still filtered.
  assert.equal(
    selectPreferredScrydexPriceEntry({ type: "graded", condition: "Gem Mint", market: 157 }),
    null,
    "single graded object must be rejected",
  );
  const singleRaw = selectPreferredScrydexPriceEntry({ type: "raw", condition: "Near Mint", market: 3.06 });
  assert.ok(singleRaw);
  assert.equal(singleRaw.price, 3.06);
}

runScrydexRawPriceSelectionTests();

// ── Graded extraction tests ───────────────────────────────────────────────────

function runScrydexGradedExtractionTests() {
  // 1. Happy path — multiple graded tiers extracted, raw excluded.
  const mixed = [
    { type: "raw", condition: "Near Mint", market: 3.06 },
    { type: "graded", company: "PSA", grade: "10", market: 157.0, low: 140, high: 175 },
    { type: "graded", company: "PSA", grade: "9", market: 20.5, low: 18, high: 24 },
    { type: "graded", company: "CGC", grade: "9.5", market: 45.0 },
    { type: "graded", company: "BGS", grade: "10", is_perfect: true, market: 500.0 },
  ];
  const results = selectScrydexGradedEntries(mixed);
  assert.equal(results.length, 4, "should extract 4 graded entries, not the raw one");

  const psa10 = results.find((r) => r.provider === "PSA" && r.gradeBucket === "G10");
  assert.ok(psa10, "PSA G10 must be present");
  assert.equal(psa10.price, 157.0);
  assert.equal(psa10.low, 140);
  assert.equal(psa10.high, 175);

  const psa9 = results.find((r) => r.provider === "PSA" && r.gradeBucket === "G9");
  assert.ok(psa9);
  assert.equal(psa9.price, 20.5);

  const cgc95 = results.find((r) => r.provider === "CGC" && r.gradeBucket === "G9_5");
  assert.ok(cgc95, "CGC G9_5 must be present for grade '9.5'");
  assert.equal(cgc95.price, 45.0);

  const bgsPerfect = results.find((r) => r.provider === "BGS" && r.gradeBucket === "G10_PERFECT");
  assert.ok(bgsPerfect, "BGS G10_PERFECT must be present when is_perfect=true");
  assert.equal(bgsPerfect.price, 500.0);
  assert.equal(bgsPerfect.isPerfect, true);

  // 2. Signed and error rows are rejected.
  const flagged = [
    { type: "graded", company: "PSA", grade: "10", is_signed: true, market: 300 },
    { type: "graded", company: "PSA", grade: "9", is_error: true, market: 200 },
    { type: "graded", company: "PSA", grade: "8", market: 15 },
  ];
  const flaggedResults = selectScrydexGradedEntries(flagged);
  assert.equal(flaggedResults.length, 1, "signed and error must be rejected");
  assert.equal(flaggedResults[0].gradeBucket, "G8");

  // 3. Unknown company is rejected.
  const unknownCompany = [
    { type: "graded", company: "SGC", grade: "10", market: 100 },
  ];
  assert.equal(selectScrydexGradedEntries(unknownCompany).length, 0);

  // 4. Unknown grade string is rejected (never fabricate).
  const unknownGrade = [
    { type: "graded", company: "PSA", grade: "AUTHENTIC", market: 50 },
  ];
  assert.equal(selectScrydexGradedEntries(unknownGrade).length, 0);

  // 5. Missing grade or company is rejected.
  const missingFields = [
    { type: "graded", grade: "10", market: 100 },      // no company
    { type: "graded", company: "PSA", market: 100 },    // no grade
  ];
  assert.equal(selectScrydexGradedEntries(missingFields).length, 0);

  // 6. Dedup: two PSA 10 entries → keep the one with better scoring.
  const dupes = [
    { type: "graded", company: "PSA", grade: "10", low: 140, market: 157 },
    { type: "graded", company: "PSA", grade: "10", market: 160 },
  ];
  const dedupResults = selectScrydexGradedEntries(dupes);
  assert.equal(dedupResults.length, 1, "dedup: one entry per (provider, bucket)");
  assert.equal(dedupResults[0].price, 157, "dedup: entry with market+low wins");

  // 7. Empty / null inputs.
  assert.deepEqual(selectScrydexGradedEntries(null), []);
  assert.deepEqual(selectScrydexGradedEntries(undefined), []);
  assert.deepEqual(selectScrydexGradedEntries([]), []);

  // 8. Raw-only array returns empty (no graded).
  const rawOnly = [
    { type: "raw", condition: "Near Mint", market: 3.06 },
  ];
  assert.equal(selectScrydexGradedEntries(rawOnly).length, 0);

  // 9. is_perfect overrides grade value to G10_PERFECT.
  const perfectOverride = [
    { type: "graded", company: "CGC", grade: "10", is_perfect: true, market: 800 },
    { type: "graded", company: "CGC", grade: "10", market: 200 },
  ];
  const perfectResults = selectScrydexGradedEntries(perfectOverride);
  assert.equal(perfectResults.length, 2, "perfect and non-perfect are different buckets");
  assert.ok(perfectResults.some((r) => r.gradeBucket === "G10_PERFECT" && r.price === 800));
  assert.ok(perfectResults.some((r) => r.gradeBucket === "G10" && r.price === 200));
}

runScrydexGradedExtractionTests();

console.log("scrydex raw price selection tests passed");
console.log("scrydex graded extraction tests passed");
