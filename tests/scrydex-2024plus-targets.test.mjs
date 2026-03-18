import assert from "node:assert/strict";
import {
  getScrydex2024PlusDailyChunk,
  SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT,
  SCRYDEX_2024_PLUS_PROVIDER_SET_IDS,
  splitProviderSetIdsIntoDailyChunks,
} from "../lib/backfill/scrydex-2024plus-targets.ts";

function runScrydex2024PlusTargetTests() {
  const chunks = splitProviderSetIdsIntoDailyChunks(SCRYDEX_2024_PLUS_PROVIDER_SET_IDS);

  assert.equal(chunks.length, SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [8, 8, 7, 7]);
  assert.deepEqual(chunks.flat(), [...SCRYDEX_2024_PLUS_PROVIDER_SET_IDS]);
  assert.deepEqual(getScrydex2024PlusDailyChunk(1), chunks[0]);
  assert.deepEqual(getScrydex2024PlusDailyChunk(4), chunks[3]);
  assert.throws(() => getScrydex2024PlusDailyChunk(0), /Invalid Scrydex 2024\+ daily chunk/);
}

runScrydex2024PlusTargetTests();

console.log("scrydex 2024+ target tests passed");
