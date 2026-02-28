import assert from "node:assert/strict";
import { fetchAllPages } from "../scripts/backfill-search-normalization.mjs";

export async function runSearchBackfillPaginationTests() {
  const calls = [];

  function makeQuery() {
    return {
      range(from, to) {
        calls.push([from, to]);

        if (from === 0) {
          return Promise.resolve({ data: [{ id: 1 }, { id: 2 }], error: null });
        }

        if (from === 2) {
          return Promise.resolve({ data: [{ id: 3 }], error: null });
        }

        return Promise.resolve({ data: [], error: null });
      },
    };
  }

  const rows = await fetchAllPages("test", makeQuery, 2);

  assert.deepEqual(calls, [
    [0, 1],
    [2, 3],
  ]);
  assert.equal(rows.length, 3);
}
