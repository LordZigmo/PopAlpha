import assert from "node:assert/strict";
import { buildTrackedSelectionPlan } from "../lib/cron/justtcg-tracked-selection.mjs";

export function runJustTcgTrackedSelectionTests() {
  const trackedRows = [
    { canonical_slug: "base-4-charizard", printing_id: "print-charizard" },
    { canonical_slug: "base-2-blastoise", printing_id: "print-blastoise" },
  ];

  const mappingRows = [
    {
      id: "map-charizard",
      printing_id: "print-charizard",
      external_id: "variant-charizard",
      meta: {
        provider_set_id: "base-set-pokemon",
        provider_variant_id: "variant-charizard",
      },
    },
  ];

  const plan = buildTrackedSelectionPlan(trackedRows, mappingRows);

  assert.equal(plan.eligibleMappings.length, 1);
  assert.equal(plan.skippedEntries.length, 1);
  assert.equal(plan.skippedEntries[0]?.canonical_slug, "base-2-blastoise");
  assert.equal(plan.skippedEntries[0]?.reason, "MISSING_JUSTTCG_MAPPING");

  const eligiblePrintingIds = new Set(plan.eligibleMappings.map((row) => row.printing_id));
  for (const skipped of plan.skippedEntries) {
    assert.equal(eligiblePrintingIds.has(skipped.printing_id), false);
  }
}

