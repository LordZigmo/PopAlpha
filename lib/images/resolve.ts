/**
 * Pick the best available image URL for a card, preferring the
 * Supabase-mirrored copy and falling back to the original provider URL.
 *
 * Pure function — safe to import from server components, API routes, and
 * any `lib/data/*` reader. No database or server-only dependencies.
 *
 * Usage:
 *   const { full, thumb } = resolveCardImage({
 *     mirrored_image_url:       row.mirrored_image_url,
 *     mirrored_thumb_url:       row.mirrored_thumb_url,
 *     image_url:                row.image_url,
 *   });
 */

export type CardImageInput = {
  // card_printings shape
  mirrored_image_url?: string | null;
  mirrored_thumb_url?: string | null;
  image_url?: string | null;

  // canonical_cards shape
  mirrored_primary_image_url?: string | null;
  mirrored_primary_thumb_url?: string | null;
  primary_image_url?: string | null;
};

export type CardImageResolved = {
  full: string | null;
  thumb: string | null;
};

export function resolveCardImage(row: CardImageInput | null | undefined): CardImageResolved {
  if (!row) return { full: null, thumb: null };

  const mirroredFull = row.mirrored_image_url ?? row.mirrored_primary_image_url ?? null;
  const mirroredThumb = row.mirrored_thumb_url ?? row.mirrored_primary_thumb_url ?? null;
  const providerFull = row.image_url ?? row.primary_image_url ?? null;

  const full = mirroredFull ?? providerFull;
  // If we have a mirrored thumb, use it; otherwise fall back to whatever
  // full-size URL we ended up with so the UI still renders something.
  const thumb = mirroredThumb ?? full;

  return { full, thumb };
}
