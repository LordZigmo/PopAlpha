import assert from "node:assert/strict";
import { buildHighlightSegments, extractHighlightTokens } from "../lib/search/highlight.mjs";

export function runSearchHighlightTests() {
  const tokens = extractHighlightTokens("Charizard base 04");
  assert.deepEqual(tokens, ["charizard", "base", "4"]);

  const segments = buildHighlightSegments("Charizard Base Set #4", tokens);
  assert.deepEqual(
    segments.filter((segment) => segment.match).map((segment) => segment.text.toLowerCase()),
    ["charizard", "base", "4"],
  );

  const plainSegments = buildHighlightSegments("Bubble Mew", []);
  assert.deepEqual(plainSegments, [{ text: "Bubble Mew", match: false }]);
}
