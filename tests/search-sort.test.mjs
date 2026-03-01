import assert from "node:assert/strict";
import { parseSearchSort, sortSearchResults } from "../lib/search/sort.mjs";

export function runSearchSortTests() {
  assert.equal(parseSearchSort(undefined), "relevance");
  assert.equal(parseSearchSort("newest"), "newest");
  assert.equal(parseSearchSort("bogus"), "relevance");

  const rows = [
    {
      canonical_slug: "base-4-charizard",
      canonical_name: "Charizard",
      set_name: "Base Set",
      year: 1999,
    },
    {
      canonical_slug: "lost-origin-tg03-charizard",
      canonical_name: "Charizard",
      set_name: "Lost Origin",
      year: 2022,
    },
    {
      canonical_slug: "mystery-charizard",
      canonical_name: "Charizard",
      set_name: "Unknown Set",
      year: null,
    },
  ];

  const newest = sortSearchResults(rows, "newest");
  assert.deepEqual(newest.map((row) => row.canonical_slug), [
    "lost-origin-tg03-charizard",
    "base-4-charizard",
    "mystery-charizard",
  ]);

  const oldest = sortSearchResults(rows, "oldest");
  assert.deepEqual(oldest.map((row) => row.canonical_slug), [
    "base-4-charizard",
    "lost-origin-tg03-charizard",
    "mystery-charizard",
  ]);
}
