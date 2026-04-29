/**
 * Synthetic augmentations for the scanner reference index.
 *
 * Context: real user scans land at cos_sim ~0.7 against the Scrydex
 * product-shot reference embeddings, which is too far for top-1 to
 * resolve cleanly. The reference index was trained on one "perfect"
 * version of each card; iPhone captures differ along many axes at
 * once (lighting, white balance, angle, compression, sensor noise,
 * glare, hand occlusion). Rather than fine-tune the embedder on
 * iPhone captures, we pre-generate a small number of synthetic
 * variants of each reference that approximate common iPhone-capture
 * conditions, embed them all under the same canonical_slug, and let
 * pgvector's kNN return the closest variant's slug — same model,
 * same runtime cost per query, just more shots on goal per card.
 *
 * Recipe v1 (variants 1-2): brightness/WB/rotate/JPEG. Addresses
 * flat-on-table / on-surface captures. Validated 2026-04-24:
 * 0→3/6 top-1 on flat eval subset. Active.
 *
 * Recipe v2 (variants 3-4): RETIRED 2026-04-29. The synthetic thumb-
 * overlay augmentations were intended to address corner-held captures
 * but instead became skin-tone magnets — any user photo with a real
 * thumb in similar position landed on the v4 (top-left) variant of
 * whichever card had the strongest residual holographic-foil signal
 * underneath. astral-radiance-102-hisuian-samurott-vstar emerged as
 * the dominant lighthouse, falsely predicted for ~10 unrelated
 * holo-foil VSTAR/V/ex cards in the 277-image eval. Filtering v3/v4
 * out of kNN gave +4% top-1 immediately. The cron no longer generates
 * them; existing rows in card_image_embeddings + their storage
 * objects are deleted by app/api/admin/cleanup/delete-thumb-overlay-augs
 * and scripts/delete-thumb-overlay-storage.mjs. The thumb-overlay
 * SVG-blob composite function is gone — bringing it back means
 * confronting the same lighthouse mechanism, so don't, write a
 * proper finetune instead.
 *
 * Each variant's recipeId is included in source_hash. Adding new
 * variants does NOT invalidate existing ones — new recipeIds just
 * trigger fresh generation for those indices. Only modifying an
 * existing recipe's params (same recipeId, different transform)
 * requires a recipeId rename to force re-embed.
 */

import sharp from "sharp";

/**
 * Marker for "what generation of the augmentation system produced
 * this". Purely informational now — the actual invalidation hook is
 * `recipeId` per variant. Kept in the hash for historical continuity;
 * don't bump unless you want every previously-generated variant
 * re-embedded (expensive).
 */
export const AUGMENTATION_RECIPE_VERSION = "augv1";

export type AugmentationVariant = {
  /** Stable int stored in card_image_embeddings.variant_index. */
  index: number;
  /** Human-readable id, included in storage path + source_hash. */
  recipeId: string;
  /** One-line description that flows into notes / debug logging. */
  description: string;
  /** Produces the augmented JPEG bytes from the original reference. */
  transform: (input: Buffer) => Promise<Buffer>;
};

const TARGET_LONG_EDGE = 768;
const WHITE_BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 } as const;

/**
 * Pipeline shared across variants: cap the long edge at 768px so
 * sharp operations are cheap, always output JPEG to match what
 * Replicate's CLIP sees at query time, keep a consistent color model.
 */
async function pipelineFromVariant(
  input: Buffer,
  options: {
    brightness: number;
    saturation: number;
    rotateDeg: number;
    jpegQuality: number;
    blurSigma?: number;
  },
): Promise<Buffer> {
  let pipeline = sharp(input, { failOn: "none" })
    .resize({
      width: TARGET_LONG_EDGE,
      height: TARGET_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .modulate({ brightness: options.brightness, saturation: options.saturation });

  if (Math.abs(options.rotateDeg) > 0.01) {
    pipeline = pipeline.rotate(options.rotateDeg, { background: WHITE_BACKGROUND });
  }

  if (options.blurSigma && options.blurSigma > 0) {
    pipeline = pipeline.blur(options.blurSigma);
  }

  return pipeline.jpeg({ quality: options.jpegQuality, mozjpeg: true }).toBuffer();
}

/**
 * Augmentation variants. Each approximates a different slice of
 * iPhone-capture distribution:
 *
 *   Recipe v1 (indices 1-2) — flat-capture conditions:
 *     1 phone-warm: warmer WB, +3° tilt, JPEG q=80
 *     2 phone-cool: cooler WB, -5° tilt, JPEG q=72, soft blur
 *
 * Recipe v2 (variants 3-4) was retired 2026-04-29 — see file header.
 * If you're tempted to add new corner-occlusion variants, don't:
 * synthetic skin-tone overlays act as universal magnets in CLIP
 * embedding space and create lighthouse cards. Real progress on
 * occlusion comes from fine-tuning, not augmentation.
 *
 * More variants can land later (perspective skew, glare overlay
 * without skin tones, motion blur, sleeve texture) behind the same
 * interface. Adding a new entry here does NOT invalidate existing
 * variants — only the new recipeId gets fresh generation.
 */
export const AUGMENTATION_VARIANTS: AugmentationVariant[] = [
  {
    index: 1,
    recipeId: "augv1-phone-warm",
    description: "warm WB, +3° rotate, JPEG q=80",
    transform: (input) =>
      pipelineFromVariant(input, {
        brightness: 1.08,
        saturation: 1.05,
        rotateDeg: 3,
        jpegQuality: 80,
      }),
  },
  {
    index: 2,
    recipeId: "augv1-phone-cool",
    description: "cool WB, -5° rotate, JPEG q=72, soft blur",
    transform: (input) =>
      pipelineFromVariant(input, {
        brightness: 0.92,
        saturation: 0.95,
        rotateDeg: -5,
        jpegQuality: 72,
        blurSigma: 0.4,
      }),
  },
];

/**
 * Full list of variant indices the cron maintains. `0` is the
 * un-augmented reference (the original canonical mirror image
 * already in the index). Augmented variants start at 1.
 */
export const ALL_VARIANT_INDICES = [
  0,
  ...AUGMENTATION_VARIANTS.map((v) => v.index),
];
