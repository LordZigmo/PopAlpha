import assert from "node:assert/strict";
import { normalizeHoldingGrade, isGradedBucket } from "../lib/holdings/grade-normalize.ts";

export function runHoldingsGradeNormalizeTests() {
  // ── RAW / null / empty ────────────────────────────────────────────────────
  assert.equal(normalizeHoldingGrade(null), "RAW");
  assert.equal(normalizeHoldingGrade(undefined), "RAW");
  assert.equal(normalizeHoldingGrade(""), "RAW");
  assert.equal(normalizeHoldingGrade("   "), "RAW");
  assert.equal(normalizeHoldingGrade("RAW"), "RAW");
  assert.equal(normalizeHoldingGrade("raw"), "RAW");

  // ── Condition-level grades collapse to RAW ───────────────────────────────
  // (card_metrics doesn't differentiate condition; condition prices live
  // in card_condition_prices and surface separately on the card detail.)
  assert.equal(normalizeHoldingGrade("NM"), "RAW");
  assert.equal(normalizeHoldingGrade("Near Mint"), "RAW");
  assert.equal(normalizeHoldingGrade("nm"), "RAW");
  assert.equal(normalizeHoldingGrade("LP"), "RAW");
  assert.equal(normalizeHoldingGrade("MP"), "RAW");
  assert.equal(normalizeHoldingGrade("HP"), "RAW");
  assert.equal(normalizeHoldingGrade("DMG"), "RAW");

  // ── PSA / CGC / BGS / TAG numeric grades (the iOS GradeOption set) ───────
  assert.equal(normalizeHoldingGrade("PSA 10"), "G10");
  assert.equal(normalizeHoldingGrade("PSA 9"), "G9");
  assert.equal(normalizeHoldingGrade("PSA 8"), "G8");
  assert.equal(normalizeHoldingGrade("PSA 7"), "LE_7");
  assert.equal(normalizeHoldingGrade("CGC 10"), "G10");
  assert.equal(normalizeHoldingGrade("CGC 9.5"), "G9_5");
  assert.equal(normalizeHoldingGrade("CGC 9"), "G9");
  assert.equal(normalizeHoldingGrade("BGS 10"), "G10");
  assert.equal(normalizeHoldingGrade("BGS 9.5"), "G9_5");
  assert.equal(normalizeHoldingGrade("BGS 9"), "G9");
  assert.equal(normalizeHoldingGrade("TAG 10"), "G10");

  // ── Boundary / sub-grade behavior ────────────────────────────────────────
  // Same boundaries as the Scrydex extractor's SCRYDEX_GRADE_MAP — keeps
  // the bucket vocabulary consistent across ingest and surfacing.
  assert.equal(normalizeHoldingGrade("PSA 1"), "LE_7");
  assert.equal(normalizeHoldingGrade("PSA 6.5"), "LE_7");
  assert.equal(normalizeHoldingGrade("PSA 7.5"), "LE_7");
  assert.equal(normalizeHoldingGrade("PSA 8.5"), "G8");
  assert.equal(normalizeHoldingGrade("PSA 9.5"), "G9_5");

  // ── Perfect / Black Label tier ───────────────────────────────────────────
  assert.equal(normalizeHoldingGrade("CGC 10 Perfect"), "G10_PERFECT");
  assert.equal(normalizeHoldingGrade("CGC Perfect 10"), "G10_PERFECT");
  assert.equal(normalizeHoldingGrade("BGS 10 Black Label"), "G10_PERFECT");
  assert.equal(normalizeHoldingGrade("BGS 10 Black-Label"), "G10_PERFECT");

  // ── Junk input falls back to RAW (never throws) ─────────────────────────
  assert.equal(normalizeHoldingGrade("???"), "RAW");
  assert.equal(normalizeHoldingGrade("PSA"), "RAW"); // no number
  assert.equal(normalizeHoldingGrade("Authentic"), "RAW"); // no number
  assert.equal(normalizeHoldingGrade("foo bar baz"), "RAW");

  // ── isGradedBucket ───────────────────────────────────────────────────────
  assert.equal(isGradedBucket("RAW"), false);
  assert.equal(isGradedBucket("G10"), true);
  assert.equal(isGradedBucket("G9_5"), true);
  assert.equal(isGradedBucket("LE_7"), true);
  assert.equal(isGradedBucket("G10_PERFECT"), true);
}
