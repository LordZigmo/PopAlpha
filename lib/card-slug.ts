function normalizePart(value: string): string {
  return value
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

