import assert from "node:assert/strict";
import { choosePreferredRawPricingPrinting } from "../lib/cards/raw-pricing-printing.ts";
import { filterRawHistoryRowsForPrinting } from "../lib/pricing/raw-history.ts";
import { resolveSnapshotTrust } from "../lib/pricing/snapshot-trust.ts";

const printingId = "76518874-8940-4f18-9bd4-7fbb2523501c";
const otherPrintingId = "5dabb660-5a95-4657-b81f-d3710440d827";

const mixedHistoryRows = [
  { provider: "SCRYDEX", variant_ref: `${printingId}::RAW`, ts: "2026-05-14T00:00:00.000Z" },
  { provider: "SCRYDEX", variant_ref: `${printingId}::sv3pt5-7:normal::RAW`, ts: "2026-05-14T00:01:00.000Z" },
  { provider: "SCRYDEX", variant_ref: `${printingId}::PSA::9`, ts: "2026-05-14T00:02:00.000Z" },
  { provider: "SCRYDEX", variant_ref: `${printingId}::CGC::10`, ts: "2026-05-14T00:03:00.000Z" },
  { provider: "SCRYDEX", variant_ref: `${otherPrintingId}::sv3pt5-7:normal::RAW`, ts: "2026-05-14T00:04:00.000Z" },
];

assert.deepEqual(
  filterRawHistoryRowsForPrinting(mixedHistoryRows, printingId).map((row) => row.variant_ref),
  [
    `${printingId}::RAW`,
    `${printingId}::sv3pt5-7:normal::RAW`,
  ],
);

assert.equal(
  choosePreferredRawPricingPrinting([
    {
      id: "first-edition-holo",
      language: "EN",
      edition: "FIRST_EDITION",
      stamp: null,
      finish: "HOLO",
      updated_at: "2026-05-14T00:00:00.000Z",
    },
    {
      id: "japanese-non-holo",
      language: "JA",
      edition: "UNLIMITED",
      stamp: null,
      finish: "NON_HOLO",
      updated_at: "2026-05-14T00:00:00.000Z",
    },
    {
      id: "english-unlimited-non-holo",
      language: "EN",
      edition: "UNLIMITED",
      stamp: null,
      finish: "NON_HOLO",
      updated_at: "2026-05-13T00:00:00.000Z",
    },
  ])?.id,
  "english-unlimited-non-holo",
);

assert.deepEqual(
  resolveSnapshotTrust(
    {
      market_price: 1.49,
      market_confidence_score: 0,
      market_low_confidence: true,
      market_blend_policy: "NO_PRICE",
    },
    {
      confidenceScore: 59,
      lowConfidence: false,
      blendPolicy: "SCRYDEX_PRIMARY",
    },
  ),
  {
    confidenceScore: 0,
    lowConfidence: true,
    blendPolicy: "NO_PRICE",
  },
);

console.log("lean price identity lock tests passed");
