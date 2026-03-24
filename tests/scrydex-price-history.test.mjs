import assert from "node:assert/strict";
import {
  buildScrydexRecentHistoryCatchupPlan,
  calculateScrydexDailyCaptureRequests,
  calculateScrydexHistoryBackfillCredits,
  historyDateToSnapshotTs,
  isMissingScrydexCardHistoryErrorMessage,
  isRetryableHistoryWriteErrorMessage,
  providerVariantIdToScrydexToken,
  retryHistoryWriteOperation,
  selectScrydexRawHistoryPrice,
  summarizeScrydexRecentHistoryCoverage,
} from "../lib/backfill/scrydex-price-history.ts";

async function runScrydexPriceHistoryTests() {
  assert.equal(calculateScrydexDailyCaptureRequests(0), 1);
  assert.equal(calculateScrydexDailyCaptureRequests(245), 3);
  assert.equal(calculateScrydexHistoryBackfillCredits(5), 15);

  assert.deepEqual(
    summarizeScrydexRecentHistoryCoverage({
      expectedCardCount: 245,
      matchedCardCount: 200,
      cardsWithRecentSnapshot: 150,
      recentHistoryDays: 90,
    }),
    {
      recentHistoryDays: 90,
      cardsWithRecentSnapshot: 150,
      cardsMissingRecentSnapshot: 50,
      cardsMissingMappings: 45,
      needsHistoryCatchup: true,
    },
  );

  const recentPlan = buildScrydexRecentHistoryCatchupPlan({
    audits: [
      {
        providerSetId: "sv10",
        setCode: "sv10",
        setName: "Destined Rivals",
        expectedCardCount: 244,
        providerCardCount: 244,
        matchedCardCount: 244,
        dailyCaptureRequests: 3,
        historyBackfillRequests: 244,
        historyBackfillCredits: 732,
        priorityReasons: [],
        recentHistoryDays: 90,
        cardsWithRecentSnapshot: 44,
        cardsMissingRecentSnapshot: 200,
        cardsMissingMappings: 0,
        needsHistoryCatchup: true,
      },
      {
        providerSetId: "sv9",
        setCode: "sv9",
        setName: "Journey Together",
        expectedCardCount: 190,
        providerCardCount: 190,
        matchedCardCount: 190,
        dailyCaptureRequests: 2,
        historyBackfillRequests: 190,
        historyBackfillCredits: 570,
        priorityReasons: [],
        recentHistoryDays: 90,
        cardsWithRecentSnapshot: 130,
        cardsMissingRecentSnapshot: 60,
        cardsMissingMappings: 0,
        needsHistoryCatchup: true,
      },
    ],
    maxCredits: 450,
  });
  assert.equal(recentPlan.estimatedCredits, 450);
  assert.equal(recentPlan.plannedCards, 150);
  assert.equal(recentPlan.selectedSets.length, 1);
  assert.equal(recentPlan.selectedSets[0].providerSetId, "sv10");
  assert.equal(recentPlan.selectedSets[0].plannedCardCount, 150);

  assert.equal(historyDateToSnapshotTs("2026-03-17"), "2026-03-17T12:00:00.000Z");
  assert.equal(providerVariantIdToScrydexToken("sv3pt5-7:reverseHolofoil"), "reverseholofoil");
  assert.equal(providerVariantIdToScrydexToken("sv3pt5-7:pokemonCenterStamp"), "pokemoncenterstamp");

  const reverseHolo = selectScrydexRawHistoryPrice([
    {
      variant: "reverseHolofoil",
      condition: "LP",
      type: "raw",
      market: 0.25,
      currency: "USD",
    },
    {
      variant: "reverseHolofoil",
      condition: "NM",
      type: "raw",
      market: 0.31,
      currency: "USD",
    },
    {
      variant: "reverseHolofoil",
      grade: "10",
      company: "PSA",
      type: "graded",
      market: 300,
      currency: "USD",
    },
  ], "reverseholofoil");
  assert.deepEqual(reverseHolo, {
    price: 0.31,
    currency: "USD",
    condition: "nm",
  });

  const stamped = selectScrydexRawHistoryPrice([
    {
      variant: "pokemonCenterStamp",
      condition: "NM",
      type: "raw",
      low: 180,
      market: 145.53,
      currency: "USD",
    },
    {
      variant: "normal",
      condition: "NM",
      type: "raw",
      market: 0.18,
      currency: "USD",
    },
  ], "pokemoncenterstamp");
  assert.deepEqual(stamped, {
    price: 145.53,
    currency: "USD",
    condition: "nm",
  });

  const noNearMint = selectScrydexRawHistoryPrice([
    {
      variant: "normal",
      condition: "LP",
      type: "raw",
      market: 0.22,
      currency: "USD",
    },
  ], "normal");
  assert.equal(noNearMint, null);

  assert.equal(isRetryableHistoryWriteErrorMessage("TypeError: fetch failed"), true);
  assert.equal(isRetryableHistoryWriteErrorMessage("statement timeout"), true);
  assert.equal(isRetryableHistoryWriteErrorMessage("row violates not-null constraint"), false);
  assert.equal(isMissingScrydexCardHistoryErrorMessage("Scrydex API error 404: "), true);
  assert.equal(isMissingScrydexCardHistoryErrorMessage("Scrydex API error 500: boom"), false);

  let retryAttempts = 0;
  const retryValue = await retryHistoryWriteOperation("history write", async () => {
    retryAttempts += 1;
    if (retryAttempts < 3) throw new Error("TypeError: fetch failed");
    return "ok";
  }, { maxAttempts: 3, baseBackoffMs: 0, jitterMs: 0 });
  assert.equal(retryValue, "ok");
  assert.equal(retryAttempts, 3);

  let permanentAttempts = 0;
  await assert.rejects(
    retryHistoryWriteOperation("history write", async () => {
      permanentAttempts += 1;
      throw new Error("permanent failure");
    }, { maxAttempts: 3, baseBackoffMs: 0, jitterMs: 0 }),
    /history write: permanent failure/,
  );
  assert.equal(permanentAttempts, 1);
}

await runScrydexPriceHistoryTests();

console.log("scrydex price history tests passed");
