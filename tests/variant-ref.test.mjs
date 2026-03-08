import assert from "node:assert/strict";
import {
  buildProviderHistoryVariantRef,
  buildVariantRef,
  buildRawVariantRef,
  buildGradedVariantRef,
  parseVariantRef,
} from "../lib/identity/variant-ref.mjs";

export function runVariantRefTests() {
  const printingId = "d1694cdf-7fca-48d1-b8ed-bb17e0c33f05";

  assert.equal(buildRawVariantRef(printingId), `${printingId}::RAW`);
  assert.equal(buildVariantRef({ printingId, grade: "RAW" }), `${printingId}::RAW`);
  assert.equal(buildVariantRef({ printingId, provider: "JUSTTCG", grade: "RAW" }), `${printingId}::RAW`);

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

  assert.deepEqual(parseVariantRef(`${printingId}::RAW`), {
    printingId,
    mode: "RAW",
    provider: null,
    gradeBucket: "RAW",
  });

  assert.deepEqual(parseVariantRef(`${printingId}::CGC::8`), {
    printingId,
    mode: "GRADED",
    provider: "CGC",
    gradeBucket: "8",
  });

  assert.equal(
    buildProviderHistoryVariantRef({
      printingId,
      canonicalSlug: "base-4-charizard",
      provider: "JUSTTCG",
      providerVariantId: "variant-123",
    }),
    `${printingId}::RAW`,
  );

  assert.deepEqual(
    parseVariantRef(
      buildProviderHistoryVariantRef({
        printingId,
        canonicalSlug: "base-4-charizard",
        provider: "SCRYDEX",
        providerVariantId: "variant-456",
      }),
    ),
    {
      printingId,
      mode: "RAW",
      provider: null,
      gradeBucket: "RAW",
    },
  );

  assert.equal(
    buildProviderHistoryVariantRef({
      printingId: null,
      canonicalSlug: "sealed:sv1-booster-box",
      provider: "JUSTTCG",
      providerVariantId: "variant-789",
    }),
    "sealed:sv1-booster-box::RAW::variant-789",
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
