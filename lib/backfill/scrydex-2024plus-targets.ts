export const SCRYDEX_2024_PLUS_PROVIDER_SET_IDS = [
  "sv4pt5",
  "sv5",
  "sv6",
  "sv6pt5",
  "sv7",
  "sv8",
  "tcgp-A1",
  "tcgp-A1a",
  "tcgp-PA",
  "mcd24",
  "me1",
  "me2",
  "mep",
  "rsv10pt5",
  "sv10",
  "sv8pt5",
  "sv9",
  "tcgp-A2",
  "tcgp-A2a",
  "tcgp-A2b",
  "tcgp-A3",
  "tcgp-A3a",
  "tcgp-A3b",
  "tcgp-A4",
  "tcgp-A4a",
  "tcgp-A4b",
  "tcgp-B1",
  "tcgp-PB",
  "zsv10pt5",
  "me2pt5",
] as const;

export const SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT = 4;

export function splitProviderSetIdsIntoDailyChunks(
  providerSetIds: readonly string[],
  chunkCount: number = SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT,
): string[][] {
  const safeChunkCount = Math.max(1, Math.floor(chunkCount));
  const ids = [...providerSetIds];
  const baseSize = Math.floor(ids.length / safeChunkCount);
  const remainder = ids.length % safeChunkCount;
  const chunks: string[][] = [];
  let cursor = 0;

  for (let index = 0; index < safeChunkCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0);
    chunks.push(ids.slice(cursor, cursor + size));
    cursor += size;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

export function getScrydex2024PlusDailyChunk(chunkNumber: number): string[] {
  const chunks = splitProviderSetIdsIntoDailyChunks(SCRYDEX_2024_PLUS_PROVIDER_SET_IDS);
  const index = Math.floor(chunkNumber) - 1;
  if (index < 0 || index >= chunks.length) {
    throw new Error(`Invalid Scrydex 2024+ daily chunk ${chunkNumber}`);
  }
  return chunks[index];
}
