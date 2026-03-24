import assert from "node:assert/strict";
import {
  getScrydex2024PlusTarget,
  getScrydex2024PlusDailyChunk,
  SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT,
  SCRYDEX_2024_PLUS_TARGETS,
  SCRYDEX_2024_PLUS_PROVIDER_SET_IDS,
  splitProviderSetIdsIntoDailyChunks,
} from "../lib/backfill/scrydex-2024plus-targets.ts";

function runScrydex2024PlusTargetTests() {
  const chunks = splitProviderSetIdsIntoDailyChunks(SCRYDEX_2024_PLUS_PROVIDER_SET_IDS);

  assert.equal(chunks.length, SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [4, 4, 4, 4]);
  assert.equal(SCRYDEX_2024_PLUS_TARGETS.length, SCRYDEX_2024_PLUS_PROVIDER_SET_IDS.length);
  assert.ok(SCRYDEX_2024_PLUS_PROVIDER_SET_IDS.every((setId) => !setId.startsWith("tcgp-")));
  assert.deepEqual(
    SCRYDEX_2024_PLUS_PROVIDER_SET_IDS,
    SCRYDEX_2024_PLUS_TARGETS.map((target) => target.providerSetId),
  );
  assert.equal(getScrydex2024PlusTarget("sv10")?.setName, "Destined Rivals");
  assert.deepEqual(chunks.flat(), [...SCRYDEX_2024_PLUS_PROVIDER_SET_IDS]);
  assert.deepEqual(getScrydex2024PlusDailyChunk(1), chunks[0]);
  assert.deepEqual(getScrydex2024PlusDailyChunk(4), chunks[3]);
  assert.throws(() => getScrydex2024PlusDailyChunk(0), /Invalid Scrydex 2024\+ daily chunk/);
}

runScrydex2024PlusTargetTests();

console.log("scrydex 2024+ target tests passed");
