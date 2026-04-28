import { stripDiacritics } from "@/lib/search/normalize.mjs";

// MUST stripDiacritics BEFORE the [^a-z0-9]+ replace, otherwise accented
// chars like é become separators ("Pokémon" → "pok_mon" instead of "pokemon").
// See lib/admin/scrydex-canonical-import.ts for full bug history.
function normalizePart(value: string): string {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildCardSlug(parts: Array<string | number | null | undefined>): string | null {
  const normalized = parts
    .map((part) => (part === null || part === undefined ? "" : String(part)))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(normalizePart)
    .filter((part) => part.length > 0);

  if (normalized.length === 0) return null;
  return normalized.join("_");
}

