export const SCRYDEX_2024_PLUS_TARGETS = [
  { providerSetId: "sv4pt5", setCode: "sv4pt5", setName: "Paldean Fates" },
  { providerSetId: "sv5", setCode: "sv5", setName: "Temporal Forces" },
  { providerSetId: "sv6", setCode: "sv6", setName: "Twilight Masquerade" },
  { providerSetId: "sv6pt5", setCode: "sv6pt5", setName: "Shrouded Fable" },
  { providerSetId: "sv7", setCode: "sv7", setName: "Stellar Crown" },
  { providerSetId: "sv8", setCode: "sv8", setName: "Surging Sparks" },
  { providerSetId: "mcd24", setCode: "mcd24", setName: "McDonald's Collection 2024" },
  { providerSetId: "me1", setCode: "me1", setName: "Mega Evolution" },
  { providerSetId: "me2", setCode: "me2", setName: "Phantasmal Flames" },
  { providerSetId: "mep", setCode: "mep", setName: "Mega Evolution Black Star Promos" },
  { providerSetId: "rsv10pt5", setCode: "rsv10pt5", setName: "White Flare" },
  { providerSetId: "sv10", setCode: "sv10", setName: "Destined Rivals" },
  { providerSetId: "sv8pt5", setCode: "sv8pt5", setName: "Prismatic Evolutions" },
  { providerSetId: "sv9", setCode: "sv9", setName: "Journey Together" },
  { providerSetId: "zsv10pt5", setCode: "zsv10pt5", setName: "Black Bolt" },
  { providerSetId: "me2pt5", setCode: "me2pt5", setName: "Ascended Heroes" },
] as const;

export const SCRYDEX_2024_PLUS_PROVIDER_SET_IDS = SCRYDEX_2024_PLUS_TARGETS.map((target) => target.providerSetId);

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

export function getScrydex2024PlusTarget(providerSetId: string) {
  return SCRYDEX_2024_PLUS_TARGETS.find((target) => target.providerSetId === providerSetId) ?? null;
}
