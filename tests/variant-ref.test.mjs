import assert from "node:assert/strict";
import {
  buildProviderHistoryVariantRef,
  buildVariantRef,
  buildRawVariantRef,
  buildGradedVariantRef,
  extractRawVariantPrintingId,
  isRawHistoryVariantRefForPrinting,
  parseVariantRef,
} from "../lib/identity/variant-ref.mjs";

export function runVariantRefTests() {
  const printingId = "d1694cdf-7fca-48d1-b8ed-bb17e0c33f05";

  assert.equal(buildRawVariantRef(printingId), `${printingId}::RAW`);
  assert.equal(buildVariantRef({ printingId, grade: "RAW" }), `${printingId}::RAW`);
  assert.equal(buildVariantRef({ printingId, provider: "SCRYDEX", grade: "RAW" }), `${printingId}::RAW`);

  assert.equal(
    buildGradedVariantRef(printingId, "PSA", "G9"),
    `${printingId}::PSA::9`,
  );
  assert.equal(
    buildVariantRef({ printingId, provider: "PSA", grade: "LE_7" }),
    `${printingId}::PSA::7_OR_LESS`,
  );
  assert.equal(
    buildVariantRef({ printingId, provider: "BGS", grade: "10" }),
    `${printingId}::BGS::10`,
  );

  // New buckets: G9_5 and G10_PERFECT
  assert.equal(
    buildGradedVariantRef(printingId, "CGC", "G9_5"),
    `${printingId}::CGC::9_5`,
  );
  assert.equal(
    buildGradedVariantRef(printingId, "BGS", "G10_PERFECT"),
    `${printingId}::BGS::10_PERFECT`,
  );
  assert.equal(
    buildVariantRef({ printingId, provider: "PSA", grade: "G9_5" }),
    `${printingId}::PSA::9_5`,
  );
  assert.equal(
    buildVariantRef({ printingId, provider: "CGC", grade: "10_PERFECT" }),
    `${printingId}::CGC::10_PERFECT`,
  );

  assert.deepEqual(parseVariantRef(`${printingId}::RAW`), {
    printingId,
    mode: "RAW",
    provider: null,
    gradeBucket: "RAW",
  });
  assert.equal(extractRawVariantPrintingId(`${printingId}::RAW`), printingId);
  assert.equal(extractRawVariantPrintingId(`${printingId}::sv3pt5-7:normal::RAW`), printingId);
  assert.equal(isRawHistoryVariantRefForPrinting(`${printingId}::sv3pt5-7:normal::RAW`, printingId), true);
  assert.equal(isRawHistoryVariantRefForPrinting(`${printingId}::PSA::9`, printingId), false);

  assert.deepEqual(parseVariantRef(`${printingId}::CGC::8`), {
    printingId,
    mode: "GRADED",
    provider: "CGC",
    gradeBucket: "8",
  });

  // New bucket round-trip: parse G9_5 and G10_PERFECT
  assert.deepEqual(parseVariantRef(`${printingId}::CGC::9_5`), {
    printingId,
    mode: "GRADED",
    provider: "CGC",
    gradeBucket: "9_5",
  });

  assert.deepEqual(parseVariantRef(`${printingId}::BGS::10_PERFECT`), {
    printingId,
    mode: "GRADED",
    provider: "BGS",
    gradeBucket: "10_PERFECT",
  });

  assert.equal(
    buildProviderHistoryVariantRef({
      printingId,
      canonicalSlug: "base-4-charizard",
      provider: "SCRYDEX",
      providerVariantId: "variant-123",
    }),
    `${printingId}::variant-123::RAW`,
  );

  assert.equal(
    buildProviderHistoryVariantRef({
      printingId,
      canonicalSlug: "base-4-charizard",
      provider: "SCRYDEX",
      providerVariantId: "variant-456",
    }),
    `${printingId}::variant-456::RAW`,
  );
  assert.equal(parseVariantRef(`${printingId}::variant-456::RAW`), null);
  assert.equal(extractRawVariantPrintingId(`${printingId}::PSA::9`), null);

  assert.equal(
    buildProviderHistoryVariantRef({
      printingId: null,
      canonicalSlug: "sealed:sv1-booster-box",
      provider: "SCRYDEX",
      providerVariantId: "variant-789",
    }),
    "sealed:sv1-booster-box::variant-789::RAW",
  );

  assert.equal(
    buildProviderHistoryVariantRef({
      printingId: null,
      canonicalSlug: null,
      provider: "SCRYDEX",
      providerVariantId: "variant-999",
    }),
    "scrydex:variant-999::RAW",
  );

  assert.equal(parseVariantRef("holofoil:unlimited:none:nm:en:raw"), null);
}

if (process.argv[1]?.endsWith("variant-ref.test.mjs")) {
  runVariantRefTests();
  console.log("variant ref tests passed");
}
