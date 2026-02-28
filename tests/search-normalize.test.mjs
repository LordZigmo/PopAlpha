import assert from "node:assert/strict";
import { normalizeSearchInput, normalizeSearchText } from "../lib/search/normalize.mjs";

export function runSearchNormalizeTests() {
  const normalized = normalizeSearchInput("Charizard Base 04");
  assert.deepEqual(normalized.tokens, ["charizard", "base", "4"]);
  assert.deepEqual(normalized.numeric_tokens, ["4"]);
  assert.equal(normalized.normalized_text, "charizard base 4");
  assert.equal(normalized.normalized_text, normalized.tokens.join(" "));

  const collector = normalizeSearchInput("004/102");
  assert.deepEqual(normalizeSearchInput("4/102").tokens, ["4", "102"]);
  assert.deepEqual(collector.tokens, ["4", "102"]);
  assert.deepEqual(collector.numeric_tokens, ["4", "102"]);
  assert.deepEqual(collector.collector_number_parts, ["4", "102"]);
  assert.equal(collector.normalized_text, "4 102");

  assert.deepEqual(normalizeSearchInput("Mr. Mime").tokens, ["mr", "mime"]);
  assert.deepEqual(normalizeSearchInput("1st-edition").tokens, ["1st", "edition"]);
  assert.equal(normalizeSearchText("Pokémon"), "pokemon");
}
