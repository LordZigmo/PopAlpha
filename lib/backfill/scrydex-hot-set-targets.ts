export const DEFAULT_SCRYDEX_PINNED_HOT_SET_IDS = ["sv3pt5", "swsh7"] as const;

function normalizeProviderSetId(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveScrydexPinnedHotSetIds(configuredRaw: string | null | undefined): string[] {
  const configured = String(configuredRaw ?? "")
    .split(",")
    .map((value) => normalizeProviderSetId(value))
    .filter(Boolean);

  return [...new Set([
    ...DEFAULT_SCRYDEX_PINNED_HOT_SET_IDS.map((value) => normalizeProviderSetId(value)),
    ...configured,
  ])];
}
