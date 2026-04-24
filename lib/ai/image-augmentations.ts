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
 * 0→3/6 top-1 on flat eval subset.
 *
 * Recipe v2 (variants 3-4): recipe v1 base + synthetic thumb overlay
 * at corner. Addresses corner-held captures — the failure mode the
 * eval harness cleanly separated from distribution mismatch.
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
 * Composites a skin-tone blob at a card corner to simulate a thumb
 * or finger wrapping around the edge while the user holds the card.
 * The blob is an SVG radial gradient (oval, slightly rotated) with
 * soft fall-off at the outer edge so it blends over whatever card
 * content is underneath. Not photorealistic — we're nudging CLIP to
 * associate "card with skin-tone patch at corner" with the underlying
 * card's identity, not fooling a human observer.
 *
 * Sized to cover ~10% of the visible card area, positioned ~30%
 * off-edge so the visible portion looks like a finger wrapping in
 * from outside the frame rather than a blob pasted in the middle.
 */
async function thumbOverlay(
  baseBuffer: Buffer,
  corner: "bottom-right" | "top-left",
): Promise<Buffer> {
  const meta = await sharp(baseBuffer).metadata();
  const width = meta.width ?? TARGET_LONG_EDGE;
  const height = meta.height ?? TARGET_LONG_EDGE;

  // Blob dimensions — taller than wide to roughly match thumb
  // proportions. Bigger than naive intuition because much of it is
  // positioned off the edge.
  const ellipseW = Math.round(width * 0.35);
  const ellipseH = Math.round(height * 0.48);

  let cx: number;
  let cy: number;
  let rotation: number;
  if (corner === "bottom-right") {
    cx = width - Math.round(ellipseW * 0.35);
    cy = height - Math.round(ellipseH * 0.32);
    rotation = 28;
  } else {
    cx = Math.round(ellipseW * 0.35);
    cy = Math.round(ellipseH * 0.32);
    rotation = -28;
  }

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="thumbGrad" cx="50%" cy="45%">
          <stop offset="0%" stop-color="rgb(230, 190, 165)" stop-opacity="0.98"/>
          <stop offset="45%" stop-color="rgb(215, 175, 150)" stop-opacity="0.94"/>
          <stop offset="80%" stop-color="rgb(195, 155, 130)" stop-opacity="0.72"/>
          <stop offset="100%" stop-color="rgb(170, 130, 105)" stop-opacity="0"/>
        </radialGradient>
        <filter id="softEdge" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2"/>
        </filter>
      </defs>
      <g transform="translate(${cx} ${cy}) rotate(${rotation})">
        <ellipse cx="0" cy="0" rx="${ellipseW / 2}" ry="${ellipseH / 2}"
                 fill="url(#thumbGrad)" filter="url(#softEdge)"/>
      </g>
    </svg>
  `;

  return sharp(baseBuffer)
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

/**
 * Augmentation variants. Each approximates a different slice of
 * iPhone-capture distribution:
 *
 *   Recipe v1 (indices 1-2) — flat-capture conditions:
 *     1 phone-warm: warmer WB, +3° tilt, JPEG q=80
 *     2 phone-cool: cooler WB, -5° tilt, JPEG q=72, soft blur
 *
 *   Recipe v2 (indices 3-4) — corner-held conditions:
 *     3 thumb-bottom-right: warm WB, slight tilt, thumb blob at
 *       bottom-right corner (~10% visible card coverage)
 *     4 thumb-top-left: cool WB, slight tilt, thumb blob at top-left
 *
 * More variants can land later (perspective skew, glare overlay,
 * motion blur, sleeve texture) behind the same interface. Adding a
 * new entry here does NOT invalidate existing variants — only the
 * new recipeId gets fresh generation.
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
  {
    index: 3,
    recipeId: "v2-thumb-bottom-right",
    description: "warm WB, +2° rotate, thumb overlay at bottom-right corner",
    transform: async (input) => {
      const warmed = await pipelineFromVariant(input, {
        brightness: 1.05,
        saturation: 1.02,
        rotateDeg: 2,
        jpegQuality: 85,
      });
      return thumbOverlay(warmed, "bottom-right");
    },
  },
  {
    index: 4,
    recipeId: "v2-thumb-top-left",
    description: "cool WB, -2° rotate, thumb overlay at top-left corner",
    transform: async (input) => {
      const cooled = await pipelineFromVariant(input, {
        brightness: 0.95,
        saturation: 0.98,
        rotateDeg: -2,
        jpegQuality: 80,
      });
      return thumbOverlay(cooled, "top-left");
    },
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
