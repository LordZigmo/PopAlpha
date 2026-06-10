import assert from "node:assert/strict";
import { isRetryableSupabaseEdgeErrorMessage } from "../lib/db/postgres-admin.ts";
import { applyQueuedBatchPreset } from "../lib/backfill/provider-pipeline-batch-config.ts";
import {
  DEFAULT_SCRYDEX_PINNED_HOT_SET_IDS,
  resolveScrydexPinnedHotSetIds,
} from "../lib/backfill/scrydex-hot-set-targets.ts";
import {
  buildBalancedScrydexDailyCapturePlanChunks,
  buildScrydexDailyCapturePlanRows,
  buildScrydexRecentHistoryCatchupPlan,
  calculateScrydexDailyCaptureRequests,
  calculateScrydexHistoryBackfillCredits,
  calculateScrydexStageObservationBudget,
  historyDateToSnapshotTs,
  isMissingScrydexCardHistoryErrorMessage,
  isRetryableHistoryWriteErrorMessage,
  partitionScrydexDailyCapturePlanRowsByHistoryReadiness,
  prioritizeScrydexCardHistoryTargets,
  providerVariantIdToScrydexToken,
  resolveScrydexDailyRequestBudget,
  resolveScrydexRawHistoryDays,
  retryHistoryWriteOperation,
  selectScrydexRawHistoryPrice,
  summarizeScrydexDailyHistoryReadiness,
  summarizeScrydexRecentHistoryCoverage,
} from "../lib/backfill/scrydex-price-history.ts";

async function runScrydexPriceHistoryTests() {
  assert.equal(
    isRetryableSupabaseEdgeErrorMessage("provider_card_map(load): Error code 522 Connection timed out from Cloudflare"),
    true,
  );
  assert.equal(
    isRetryableSupabaseEdgeErrorMessage("provider_card_map(load): {\"code\":\"PGRST116\",\"message\":\"not found\"}"),
    false,
  );

  assert.deepEqual([...DEFAULT_SCRYDEX_PINNED_HOT_SET_IDS], ["sv3pt5", "swsh7"]);
  assert.deepEqual(
    resolveScrydexPinnedHotSetIds("swsh7,sv10, SV3PT5 "),
    ["sv3pt5", "swsh7", "sv10"],
  );

  assert.equal(calculateScrydexDailyCaptureRequests(0), 1);
  assert.equal(calculateScrydexDailyCaptureRequests(245), 3);
  assert.equal(calculateScrydexHistoryBackfillCredits(5), 15);

  // Stage budget scales with set size (2026-06-10 starvation incident):
  // a 295-card set must never get the old flat-100 budget again.
  assert.equal(calculateScrydexStageObservationBudget(null), 500);
  assert.equal(calculateScrydexStageObservationBudget(0), 500);
  assert.equal(calculateScrydexStageObservationBudget(10), 500); // floor
  assert.equal(calculateScrydexStageObservationBudget(295), 3540); // Ascended Heroes
  assert.equal(calculateScrydexStageObservationBudget(10_000), 6000); // cap
  assert.ok(calculateScrydexStageObservationBudget(295) > 1500, "budget must exceed per-capture volume");

  // The queued-job preset must not clamp the volume budgets away (Codex
  // P1 on PR #220: the old 250 cap silently discarded them at execution).
  // First attempts pass through up to the 6000 ceiling; failing jobs
  // still de-escalate to the RETRY/MINIMAL presets.
  const firstAttempt = applyQueuedBatchPreset("SCRYDEX", "PIPELINE", 1, {
    timeseriesObservations: 3540,
    metricsObservations: 3540,
    matchObservations: 100,
  });
  assert.equal(firstAttempt.timeseriesObservations, 3540);
  assert.equal(firstAttempt.metricsObservations, 3540);
  assert.equal(
    applyQueuedBatchPreset("SCRYDEX", "PIPELINE", 2, { timeseriesObservations: 3540, matchObservations: 100 }).timeseriesObservations,
    80,
  );
  assert.equal(
    applyQueuedBatchPreset("SCRYDEX", "PIPELINE", 4, { timeseriesObservations: 3540, matchObservations: 100 }).timeseriesObservations,
    40,
  );
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

  assert.deepEqual(
    summarizeScrydexDailyHistoryReadiness([
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
        providerSetId: "swsh7",
        setCode: "swsh7",
        setName: "Evolving Skies",
        expectedCardCount: 237,
        providerCardCount: 237,
        matchedCardCount: 237,
        dailyCaptureRequests: 3,
        historyBackfillRequests: 237,
        historyBackfillCredits: 711,
        priorityReasons: [],
        recentHistoryDays: 90,
        cardsWithRecentSnapshot: 237,
        cardsMissingRecentSnapshot: 0,
        cardsMissingMappings: 0,
        needsHistoryCatchup: false,
      },
    ]),
    {
      recentHistoryDays: 90,
      totalSets: 2,
      matchedSets: 2,
      fullyCoveredSets: 1,
      incompleteSets: 1,
      matchedCards: 481,
      cardsWithRecentSnapshot: 281,
      cardsMissingRecentSnapshot: 200,
      cardsMissingMappings: 0,
      dailyRequestsReady: 3,
      dailyRequestsBlocked: 3,
      creditsToFullCoverage: 600,
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

  const prioritizedCaptureRows = buildScrydexDailyCapturePlanRows({
    footprints: [
      {
        providerSetId: "safe-set",
        setCode: "safe-set",
        setName: "Safe Set",
        expectedCardCount: 200,
        providerCardCount: 200,
        matchedCardCount: 200,
        dailyCaptureRequests: 2,
        historyBackfillRequests: 200,
        historyBackfillCredits: 600,
        priorityReasons: [],
      },
      {
        providerSetId: "risk-set",
        setCode: "risk-set",
        setName: "Risk Set",
        expectedCardCount: 200,
        providerCardCount: 200,
        matchedCardCount: 200,
        dailyCaptureRequests: 2,
        historyBackfillRequests: 200,
        historyBackfillCredits: 600,
        priorityReasons: [],
      },
    ],
    recentConsistencySetIds: [],
    staleExtremeMoverSetIds: ["risk-set"],
    highValuePrioritySetIds: [],
    coveragePrioritySetIds: [],
  });
  assert.equal(prioritizedCaptureRows[0].providerSetId, "risk-set");
  assert.equal(prioritizedCaptureRows[0].priorityReasons.includes("stale-extreme-mover"), true);

  const partitionedCaptureRows = partitionScrydexDailyCapturePlanRowsByHistoryReadiness({
    rows: prioritizedCaptureRows,
    audits: [
      {
        providerSetId: "safe-set",
        setCode: "safe-set",
        setName: "Safe Set",
        expectedCardCount: 200,
        providerCardCount: 200,
        matchedCardCount: 200,
        dailyCaptureRequests: 2,
        historyBackfillRequests: 200,
        historyBackfillCredits: 600,
        priorityReasons: [],
        recentHistoryDays: 90,
        cardsWithRecentSnapshot: 200,
        cardsMissingRecentSnapshot: 0,
        cardsMissingMappings: 0,
        needsHistoryCatchup: false,
      },
      {
        providerSetId: "risk-set",
        setCode: "risk-set",
        setName: "Risk Set",
        expectedCardCount: 200,
        providerCardCount: 200,
        matchedCardCount: 200,
        dailyCaptureRequests: 2,
        historyBackfillRequests: 200,
        historyBackfillCredits: 600,
        priorityReasons: [],
        recentHistoryDays: 90,
        cardsWithRecentSnapshot: 20,
        cardsMissingRecentSnapshot: 180,
        cardsMissingMappings: 0,
        needsHistoryCatchup: true,
      },
    ],
  });
  assert.deepEqual(
    partitionedCaptureRows.readyRows.map((row) => row.providerSetId),
    ["safe-set"],
  );
  assert.deepEqual(
    partitionedCaptureRows.blockedRows.map((row) => row.providerSetId),
    ["risk-set"],
  );
  assert.equal(partitionedCaptureRows.blockedRows[0].priorityReasons.includes("history-incomplete"), true);

  const prioritizedHistoryTargets = prioritizeScrydexCardHistoryTargets({
    targets: [
      {
        providerSetId: "swsh7",
        providerCardId: "rayquaza",
        variants: [
          {
            providerCardId: "rayquaza",
            providerVariantId: "rayquaza-vmax:normal",
            providerVariantToken: "normal",
            canonicalSlug: "evolving-skies-218-rayquaza-vmax",
            printingId: "printing-ray",
            historyVariantRef: "printing-ray::rayquaza-vmax:normal::RAW",
          },
        ],
      },
      {
        providerSetId: "swsh7",
        providerCardId: "common",
        variants: [
          {
            providerCardId: "common",
            providerVariantId: "common-card:normal",
            providerVariantToken: "normal",
            canonicalSlug: "evolving-skies-001-common-card",
            printingId: "printing-common",
            historyVariantRef: "printing-common::common-card:normal::RAW",
          },
        ],
      },
    ],
    existingVariantRefs: new Set(["printing-common::common-card:normal::RAW"]),
    slugRiskScores: new Map([["evolving-skies-218-rayquaza-vmax", 9999]]),
  });
  assert.deepEqual(
    prioritizedHistoryTargets.map((target) => target.providerCardId),
    ["rayquaza", "common"],
  );

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
  // Post 2026-05-15: raw history now prefers `low` over `market` to track
  // TCGplayer's published Market Price label. See scrydex-raw-price-select.ts
  // parseScrydexPriceObject docs. For this fixture, low=180 wins over market=145.53.
  assert.deepEqual(stamped, {
    price: 180,
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
