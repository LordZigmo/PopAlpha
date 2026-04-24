/**
 * Synthetic augmentations for the scanner reference index.
 *
 * Context: real user scans land at cos_sim ~0.7 against the Scrydex
 * product-shot reference embeddings, which is too far for top-1 to
 * resolve cleanly. The reference index was trained on one "perfect"
 * version of each card; iPhone captures differ along many axes at
 * once (lighting, white balance, angle, compression, sensor noise,
 * glare). Rather than fine-tune the embedder on iPhone captures, we
 * pre-generate a small number of synthetic variants of each reference
 * that approximate common iPhone-capture conditions, embed them all
 * under the same canonical_slug, and let pgvector's kNN return the
 * closest variant's slug — same model, same runtime cost per query,
 * just more shots on goal per card.
 *
 * Each variant bumps its own `recipeId` string. When we change an
 * augmentation recipe, the source_hash in card_image_embeddings
 * changes for that variant, which triggers the augment cron to
 * regenerate + re-embed just that variant on its next pass. No
 * manual migration step.
 */

import sharp from "sharp";

/**
 * Bump this when ANY variant's recipe changes (add a variant, tweak
 * a param, swap an effect). It flows into the source_hash so the
 * augment cron will re-embed previously-generated variants.
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
 * Two initial variants. Each approximates a different slice of
 * iPhone-capture distribution:
 *
 *   v1 "phone-warm": warmer white balance, slight clockwise tilt,
 *     moderate JPEG compression — what an indoor-light phone capture
 *     with a slight hand angle typically looks like.
 *
 *   v2 "phone-cool": cooler white balance, slight counter-clockwise
 *     tilt, lighter JPEG — what an overhead / cool-lighting phone
 *     capture typically looks like.
 *
 * More variants can land later (e.g. perspective skew, glare overlay,
 * motion blur) behind the same interface — just add entries to this
 * array and bump AUGMENTATION_RECIPE_VERSION.
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
