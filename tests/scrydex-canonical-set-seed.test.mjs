import assert from "node:assert/strict";
import { buildSetSeedRowsForScrydexImport } from "../lib/admin/scrydex-canonical-set-seed.ts";

export function runScrydexCanonicalSetSeedTests() {
  const rows = buildSetSeedRowsForScrydexImport(
    [
      {
        printings: [
          { setName: "Chaos Rising", language: "EN", year: 2026 },
          { setName: "Chaos Rising", language: "EN", year: 2026 },
        ],
      },
      {
        printings: [
          { setName: "Chaos Rising", language: "EN", year: 2026 },
          { setName: "Older Test Set", language: "EN", year: 2024 },
        ],
      },
      {
        printings: [
          { setName: null, language: "EN", year: 2026 },
        ],
      },
    ],
    "scrydex_provisional",
    "2026-05-24T08:00:00.000Z",
  );

  assert.deepEqual(rows, [
    {
      set_id: "chaos-rising",
      set_name: "Chaos Rising",
      language: "EN",
      year: 2026,
      derived_card_count: 3,
      source: "scrydex_provisional",
      updated_at: "2026-05-24T08:00:00.000Z",
    },
    {
      set_id: "older-test-set",
      set_name: "Older Test Set",
      language: "EN",
      year: 2024,
      derived_card_count: 1,
      source: "scrydex_provisional",
      updated_at: "2026-05-24T08:00:00.000Z",
    },
  ]);
}
