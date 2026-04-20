import assert from "node:assert/strict";
import { planScrydexTargetSelection } from "../lib/backfill/scrydex-raw-ingest.ts";

function makeTarget(setCode) {
  return {
    setCode,
    setName: setCode.toUpperCase(),
    providerSetId: setCode,
  };
}

function runScrydexTargetAllocationTests() {
  const availableTargets = [
    makeTarget("base1"),
    makeTarget("base2"),
    makeTarget("base3"),
    makeTarget("base4"),
    makeTarget("base5"),
    makeTarget("base6"),
    makeTarget("sv3pt5"),
    makeTarget("sv9"),
  ];

  const firstPlan = planScrydexTargetSelection({
    availableTargets,
    failedSetQueue: [],
    hotProviderSetIds: ["sv3pt5", "sv9"],
    setLimit: 6,
    cursorSetCode: null,
    hotCursorProviderSetId: null,
    selectionPhase: 0,
    hotSlotInterval: 6,
  });

  assert.deepEqual(
    firstPlan.selectedTargets.map((target) => target.providerSetId),
    ["base1", "base2", "base3", "base4", "base5", "sv3pt5"],
  );
  assert.equal(firstPlan.baselineSlotCount, 5);
  assert.equal(firstPlan.hotSlotCount, 1);
  assert.equal(firstPlan.nextSetCode, "base5");
  assert.equal(firstPlan.nextHotProviderSetId, "sv3pt5");
  assert.equal(firstPlan.nextSelectionPhase, 6);

  const secondPlan = planScrydexTargetSelection({
    availableTargets,
    failedSetQueue: [],
    hotProviderSetIds: ["sv3pt5", "sv9"],
    setLimit: 6,
    cursorSetCode: firstPlan.nextSetCode,
    hotCursorProviderSetId: firstPlan.nextHotProviderSetId,
    selectionPhase: firstPlan.nextSelectionPhase,
    hotSlotInterval: 6,
  });

  assert.deepEqual(
    secondPlan.selectedTargets.map((target) => target.providerSetId),
    ["base6", "base1", "base2", "base3", "base4", "sv9"],
  );
  assert.equal(secondPlan.hotSlotCount, 1);
  assert.equal(secondPlan.nextHotProviderSetId, "sv9");

  const failedQueuePlan = planScrydexTargetSelection({
    availableTargets,
    failedSetQueue: ["sv3pt5"],
    hotProviderSetIds: ["sv3pt5", "sv9"],
    setLimit: 3,
    cursorSetCode: null,
    hotCursorProviderSetId: null,
    selectionPhase: 0,
    hotSlotInterval: 6,
  });

  assert.deepEqual(
    failedQueuePlan.selectedTargets.map((target) => target.providerSetId),
    ["sv3pt5", "base1", "base2"],
  );
  assert.equal(failedQueuePlan.hotSlotCount, 1);
  assert.equal(failedQueuePlan.baselineSlotCount, 2);
}

runScrydexTargetAllocationTests();

console.log("scrydex target allocation tests passed");
