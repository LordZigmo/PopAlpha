import assert from "node:assert/strict";
import {
  historyDateToSnapshotTs,
  isMissingScrydexCardHistoryErrorMessage,
  isRetryableHistoryWriteErrorMessage,
  providerVariantIdToScrydexToken,
  retryHistoryWriteOperation,
  selectScrydexRawHistoryPrice,
} from "../lib/backfill/scrydex-price-history.ts";

async function runScrydexPriceHistoryTests() {
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
