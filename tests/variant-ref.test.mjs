import assert from "node:assert/strict";
import {
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

  assert.equal(parseVariantRef("holofoil:unlimited:none:nm:en:raw"), null);
}
