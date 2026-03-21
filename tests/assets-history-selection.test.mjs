import assert from "node:assert/strict";
import {
  extractRawVariantPrintingId,
  variantRefsCompatible,
} from "../lib/data/assets.ts";

function runAssetsHistorySelectionTests() {
  const printingId = "76518874-8940-4f18-9bd4-7fbb2523501c";
  const otherPrintingId = "5dabb660-5a95-4657-b81f-d3710440d827";

  assert.equal(extractRawVariantPrintingId(`${printingId}::RAW`), printingId);
  assert.equal(
    extractRawVariantPrintingId(`${printingId}::sv3pt5-7:normal::RAW`),
    printingId,
  );
  assert.equal(extractRawVariantPrintingId(`${printingId}::PSA::9`), null);

  assert.equal(
    variantRefsCompatible(
      `${printingId}::sv3pt5-7:normal::RAW`,
      `${printingId}::RAW`,
    ),
    true,
  );
  assert.equal(
    variantRefsCompatible(
      `${printingId}::sv3pt5-7:reverseholofoil::RAW`,
      `${printingId}::RAW`,
    ),
    true,
  );
  assert.equal(
    variantRefsCompatible(
      `${printingId}::sv3pt5-7:normal::RAW`,
      `${otherPrintingId}::RAW`,
    ),
    false,
  );
  assert.equal(
    variantRefsCompatible(
      `${printingId}::PSA::9`,
      `${printingId}::PSA::9`,
    ),
    true,
  );
  assert.equal(
    variantRefsCompatible(
      `${printingId}::PSA::9`,
      `${printingId}::CGC::9`,
    ),
    false,
  );
}

runAssetsHistorySelectionTests();

console.log("assets history selection tests passed");
