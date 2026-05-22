export type DisplayNameFromCanonicalSlugOptions = {
  setName?: string | null | undefined;
  cardNumber?: string | null | undefined;
};

export function displayNameFromCanonicalSlug(
  slug: string | null | undefined,
  options?: DisplayNameFromCanonicalSlugOptions,
): string;
