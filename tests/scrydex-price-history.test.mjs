import assert from "node:assert/strict";
import {
  buildBalancedScrydexDailyCapturePlanChunks,
  buildScrydexRecentHistoryCatchupPlan,
  calculateScrydexDailyCaptureRequests,
  calculateScrydexHistoryBackfillCredits,
  historyDateToSnapshotTs,
  isMissingScrydexCardHistoryErrorMessage,
  isRetryableHistoryWriteErrorMessage,
  providerVariantIdToScrydexToken,
  resolveScrydexDailyRequestBudget,
  resolveScrydexRawHistoryDays,
  retryHistoryWriteOperation,
  selectScrydexRawHistoryPrice,
  summarizeScrydexRecentHistoryCoverage,
} from "../lib/backfill/scrydex-price-history.ts";

async function runScrydexPriceHistoryTests() {
  assert.equal(calculateScrydexDailyCaptureRequests(0), 1);
  assert.equal(calculateScrydexDailyCaptureRequests(245), 3);
  assert.equal(calculateScrydexHistoryBackfillCredits(5), 15);
  assert.equal(resolveScrydexDailyRequestBudget({
    totalAvailableRequests: 347,
    recentSuccessfulRequests: 218,
  }), 330);
  assert.equal(resolveScrydexDailyRequestBudget({
    totalAvailableRequests: 347,
    recentSuccessfulRequests: 218,
    maxRequests: 280,
  }), 280);

  const balancedChunks = buildBalancedScrydexDailyCapturePlanChunks({
    chunkCount: 2,
    selectedSets: [
      {
        providerSetId: "heavy-a",
        setCode: "heavy-a",
        setName: "Heavy A",
        expectedCardCount: 300,
        providerCardCount: 300,
        matchedCardCount: 300,
        dailyCaptureRequests: 1,
        historyBackfillRequests: 300,
        historyBackfillCredits: 900,
        priorityReasons: ["matched"],
        priorityWeight: 1000,
      },
      {
        providerSetId: "heavy-b",
        setCode: "heavy-b",
        setName: "Heavy B",
        expectedCardCount: 290,
        providerCardCount: 290,
        matchedCardCount: 290,
        dailyCaptureRequests: 1,
        historyBackfillRequests: 290,
        historyBackfillCredits: 870,
        priorityReasons: ["matched"],
        priorityWeight: 990,
      },
      {
        providerSetId: "small-c",
        setCode: "small-c",
        setName: "Small C",
        expectedCardCount: 200,
        providerCardCount: 200,
        matchedCardCount: 200,
        dailyCaptureRequests: 3,
        historyBackfillRequests: 200,
        historyBackfillCredits: 600,
        priorityReasons: ["matched"],
        priorityWeight: 980,
      },
      {
        providerSetId: "small-d",
        setCode: "small-d",
        setName: "Small D",
        expectedCardCount: 190,
        providerCardCount: 190,
        matchedCardCount: 190,
        dailyCaptureRequests: 3,
        historyBackfillRequests: 190,
        historyBackfillCredits: 570,
        priorityReasons: ["matched"],
        priorityWeight: 970,
      },
    ],
  });
  assert.equal(balancedChunks.length, 2);
  assert.deepEqual(
    balancedChunks.map((chunk) => ({
      plannedRequests: chunk.plannedRequests,
      plannedExpectedCardCount: chunk.plannedExpectedCardCount,
      providerSetIds: chunk.providerSetIds,
    })),
    [
      {
        plannedRequests: 4,
        plannedExpectedCardCount: 490,
        providerSetIds: ["heavy-a", "small-d"],
      },
      {
        plannedRequests: 4,
        plannedExpectedCardCount: 490,
        providerSetIds: ["heavy-b", "small-c"],
      },
    ],
  );

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
  assert.equal(historyDateToSnapshotTs("2026/03/17"), "2026-03-17T12:00:00.000Z");
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

  const resolvedHistory = resolveScrydexRawHistoryDays({
    historyDays: [
      {
        date: "2026/03/22",
        prices: [
          {
            variant: "normal",
            condition: "NM",
            type: "raw",
            market: 1.25,
            currency: "USD",
          },
        ],
      },
      {
        date: "2026/03/23",
        prices: [
          {
            variant: "normal",
            condition: "NM",
            type: "graded",
            market: 18,
            currency: "USD",
          },
        ],
      },
      {
        date: "2026/03/25",
        prices: [
          {
            variant: "normal",
            condition: "NM",
            type: "raw",
            market: 1.55,
            currency: "USD",
          },
        ],
      },
    ],
    providerVariantToken: "normal",
    windowDays: 4,
    asOf: "2026-03-25T18:00:00.000Z",
  });
  assert.equal(resolvedHistory.providerDaysMissingRaw, 1);
  assert.deepEqual(resolvedHistory.days, [
    {
      dayKey: "2026-03-22",
      selected: {
        price: 1.25,
        currency: "USD",
        condition: "nm",
      },
      source: "provider",
    },
    {
      dayKey: "2026-03-23",
      selected: {
        price: 1.25,
        currency: "USD",
        condition: "nm",
      },
      source: "carry_forward",
    },
    {
      dayKey: "2026-03-24",
      selected: {
        price: 1.25,
        currency: "USD",
        condition: "nm",
      },
      source: "carry_forward",
    },
    {
      dayKey: "2026-03-25",
      selected: {
        price: 1.55,
        currency: "USD",
        condition: "nm",
      },
      source: "provider",
    },
  ]);

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
