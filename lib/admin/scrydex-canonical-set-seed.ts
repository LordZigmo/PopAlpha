import { buildSetId } from "@/lib/sets/summary-core.mjs";

export type ScrydexImportPreparedCardForSetSeed = {
  printings: Array<{
    setName: string | null;
    language: string;
    year: number | null;
  }>;
};

export type ScrydexImportSetSeedRow = {
  set_id: string;
  set_name: string;
  language: string | null;
  year: number | null;
  derived_card_count: number;
  source: string;
  updated_at: string;
};

export function buildSetSeedRowsForScrydexImport(
  preparedCards: ScrydexImportPreparedCardForSetSeed[],
  source: string,
  nowIso = new Date().toISOString(),
): ScrydexImportSetSeedRow[] {
  const rowsBySetId = new Map<string, ScrydexImportSetSeedRow>();

  for (const prepared of preparedCards) {
    for (const printing of prepared.printings) {
      if (!printing.setName) continue;
      const setId = buildSetId(printing.setName);
      if (!setId) continue;

      const existing = rowsBySetId.get(setId);
      if (!existing) {
        rowsBySetId.set(setId, {
          set_id: setId,
          set_name: printing.setName,
          language: printing.language || null,
          year: printing.year,
          derived_card_count: 1,
          source,
          updated_at: nowIso,
        });
        continue;
      }

      existing.derived_card_count += 1;
      if (!existing.language && printing.language) existing.language = printing.language;
      if (existing.year === null || (printing.year !== null && printing.year < existing.year)) {
        existing.year = printing.year;
      }
    }
  }

  return [...rowsBySetId.values()];
}
