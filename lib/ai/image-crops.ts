/**
 * Region crops for the scanner reference index.
 *
 * Companion to lib/ai/image-augmentations. Whereas augmentations vary
 * the *appearance* of a card (color, rotation, JPEG noise) to teach
 * CLIP iPhone-like distributions, crops vary the *region* — they
 * generate sub-images that survive specific real-world occlusion
 * patterns that augmentations can't simulate cleanly.
 *
 * The motivating failure mode (2026-04-26): a user holding a card in
 * hand with a finger covering the bottom-left corner. The collector
 * number lives there, so OCR can't read it; CLIP's full-card embedding
 * encodes the occlusion as part of the image and degrades; and the
 * synthetic thumb-overlay augmentations (recipe v2 v3/v4) didn't move
 * the eval needle, suggesting CLIP at our scale can't learn what's
 * missing from a small synthetic distribution.
 *
 * Multi-crop solves this differently: at inference time, embed BOTH
 * the full card and an art-only crop, kNN both against their matching
 * reference subsets, take max similarity per slug. The art crop
 * side-steps any occlusion that's confined to the footer, and OCR
 * still fires when the corner IS visible. The two are complementary,
 * not redundant.
 *
 * Pokemon-TCG–specific design notes:
 *
 *   1. Cards have a stable layout across eras: name strip top,
 *      art window middle, stats + footer bottom. The name strip
 *      contains highly discriminating text ("Charizard ex",
 *      "Pikachu V") that CLIP picks up directly — including it in
 *      the art crop is a strong signal, not noise.
 *
 *   2. The footer (lowest ~10%) carries the collector number, set
 *      symbol, and rules text. This is where users' fingers land
 *      most often (cards held by the bottom edge while photographed),
 *      and it's the region that's most uniform across reprints —
 *      cutting it out makes the crop more discriminating, not less.
 *
 *   3. Older cards have proportionally smaller art windows than
 *      modern cards. A fixed crop ratio of "top 62% of height"
 *      captures the full art window across all eras — Base Set
 *      through Scarlet & Violet — while excluding the footer.
 *      Full-art cards (V, ex, GX, VMAX) also work fine; the crop
 *      just becomes a sub-window of the same picture, which still
 *      has plenty of unique CLIP signal.
 *
 *   4. We intentionally do NOT generate augmented variants of art
 *      crops. Augmentation addresses appearance distribution gap;
 *      the art crop addresses occlusion. Cross-producing them adds
 *      4× rows per slug for marginal gain. One art crop per slug
 *      keeps the index growth bounded (+20% rows total).
 */

import sharp from "sharp";
import heicConvert from "heic-convert";

/**
 * The set of crop types persisted in card_image_embeddings.crop_type.
 * Add new values here when introducing further crops (e.g. a
 * name-strip-only crop) so callers can refer to them by name.
 */
export const CROP_TYPES = ["full", "art"] as const;
export type CropType = (typeof CROP_TYPES)[number];

/**
 * Stable identifier for the current crop recipe. Bump if the geometry
 * changes (e.g. you tighten the bottom ratio); existing rows then
 * become stale and the cron re-runs them. The constant is part of the
 * source_hash on art-crop rows.
 */
export const ART_CROP_RECIPE_VERSION = "art-crop-v1";

/**
 * Top fraction of the card to keep in the art crop. Empirically tuned
 * for Pokemon TCG card layout — see the Pokemon-TCG-specific notes in
 * the file header. If you tune this, also bump
 * ART_CROP_RECIPE_VERSION so existing reference embeddings get re-run.
 */
const ART_CROP_TOP_FRACTION = 0.62;

/**
 * Maximum long-edge size of the cropped JPEG written to Storage.
 * CLIP downsamples its input to 224×224 internally, so anything
 * beyond ~800px is wasted upload bandwidth without changing the
 * embedding. 800px also keeps Replicate's URL fetch fast on cold
 * starts.
 */
const ART_CROP_MAX_EDGE_PX = 800;

/**
 * Generate the art-only crop for a card image.
 *
 * Crops the top ART_CROP_TOP_FRACTION of the height (full width),
 * keeping the name strip + art window and dropping the stats / footer
 * region. Result is JPEG-encoded for upload. Throws if the input image
 * has no dimensions or is too small to crop meaningfully — those cases
 * are caller-handled (skip the slug, record a failure).
 */
export async function artCropTransform(input: Buffer): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  if (!width || !height) {
    throw new ImageCropError("source image has no dimensions");
  }

  // Sanity floor: anything narrower than 200px on either edge probably
  // isn't a real card image — bail rather than produce a garbage crop.
  if (width < 200 || height < 200) {
    throw new ImageCropError(`source image too small to crop: ${width}x${height}`);
  }

  const cropHeight = Math.max(1, Math.round(height * ART_CROP_TOP_FRACTION));

  // Pipeline: extract the top region → resize so the long edge fits
  // ART_CROP_MAX_EDGE_PX → re-encode JPEG at q=88. The resize step
  // happens AFTER the crop so the crop fraction is computed against
  // the original full-resolution image, not a pre-shrunk version.
  return sharp(input)
    .extract({ left: 0, top: 0, width, height: cropHeight })
    .resize({
      width: ART_CROP_MAX_EDGE_PX,
      height: ART_CROP_MAX_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/**
 * Apply a named crop transform. Lets callers (the inference route +
 * the embedding cron) reference crops by `crop_type` without coupling
 * to the underlying transform function.
 */
export async function applyCropTransform(
  cropType: CropType,
  input: Buffer,
): Promise<Buffer> {
  switch (cropType) {
    case "full":
      // No-op. The full-card path uses the original bytes; including
      // 'full' here keeps callers symmetrical (one switch, both paths).
      return input;
    case "art":
      return artCropTransform(input);
  }
}

/**
 * Resize a captured user photo down to a sensible upload size before
 * storing it for Replicate to fetch.
 *
 * Why this exists: 2026-04-28 we discovered TWO failure modes on the
 * scan-eval corpus:
 *
 *   1. Large JPEGs (1-2MB iPhone originals) — Replicate's URL fetch
 *      returns truncated/empty bytes for the public Storage URL of
 *      anything ≳800KB, the CLIP model treats image=None, and the
 *      prediction fails with `ended in status=failed: You have to
 *      specify either text or images. Both cannot be none.`
 *
 *   2. HEIF/HEIC inputs — newer iPhones save photos as HEIC by
 *      default, and AirDrop preserves the format. Sharp on Vercel's
 *      runtime ships a libvips build *without* libheif, so any
 *      attempt to decode HEIC throws "No decoding plugin installed
 *      for this compression format". Replicate's CLIP backend also
 *      can't decode HEIC, so passing the bytes through unchanged
 *      hits the same "no images specified" wall.
 *
 * Both failures masquerade as the same model-side error message,
 * which made diagnosis painful — at the time of the fix, 120 of 277
 * eval images were HEIC and the cliff at index 157 in the eval was
 * exactly the JPEG/HEIC boundary in the corpus.
 *
 * Resolution: this helper is the single chokepoint for "make these
 * bytes Replicate-fetchable":
 *
 *   • If the input is HEIC, decode it via the pure-JS heic-convert
 *     package (libheif WebAssembly fallback — works anywhere Node
 *     runs, no native dep needed).
 *   • Then resize with sharp to ≤800px long edge at JPEG q=88. CLIP
 *     downsamples to 224×224 internally regardless of input size, so
 *     800px is indistinguishable for embedding purposes but reliably
 *     fetchable.
 *   • Pass-through if the bytes are already a small JPEG.
 *
 * Scoped to the inference route + scan-eval ingest — the embedding
 * cron handles catalog images (~200-400KB Scrydex product shots)
 * which are always small JPEGs. Calling this from the cron would be
 * a no-op AND would force a cascading source_hash invalidation of
 * every existing embedding for no benefit.
 */
const UPLOAD_MAX_EDGE_PX = 800;

function isHeicMagic(buf: Buffer): boolean {
  // ISO-BMFF box: 4-byte size, then 'ftyp', then a brand. HEIC variants:
  //   'heic', 'heix' — single image
  //   'mif1', 'msf1' — image sequence containers
  //   'hevc'         — HEVC video (rare in photo apps but defensive)
  if (buf.length < 12) return false;
  if (buf.slice(4, 8).toString("ascii") !== "ftyp") return false;
  const brand = buf.slice(8, 12).toString("ascii");
  return brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1" || brand === "hevc";
}

async function decodeHeicToJpegBytes(input: Buffer): Promise<Buffer> {
  // heic-convert's @types declares `buffer` as ArrayBufferLike, but the
  // implementation handles Node Buffers fine (Buffer extends Uint8Array).
  // Cast to bypass the structural mismatch — at runtime it's a no-op.
  // Output is an ArrayBuffer; wrap in Buffer.from. Quality is 0..1
  // (not 0..100) — 0.92 is visually indistinguishable from HEIF source
  // for CLIP's purposes; CLIP downsamples to 224×224 either way.
  const out = await heicConvert({
    buffer: input as unknown as ArrayBufferLike,
    format: "JPEG",
    quality: 0.92,
  });
  return Buffer.from(out);
}

export async function resizeForUpload(input: Buffer): Promise<Buffer> {
  // Step 1: HEIC → JPEG decode if needed. heic-convert is slower than
  // sharp (~1-2s per image) but it's the only path that works without
  // native libheif on Vercel. Run it BEFORE sharp because sharp can't
  // read HEIC at all on the deployed runtime.
  let bytes = input;
  if (isHeicMagic(input)) {
    bytes = await decodeHeicToJpegBytes(input);
  }

  // Step 2: Sharp metadata + resize. After the optional HEIC decode,
  // bytes is guaranteed to be a JPEG (or PNG/WebP if we ever extend),
  // and sharp can read it.
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // No metadata or already small — pass through. Avoids needless
  // re-encoding of already-tiny captures.
  if (
    width === 0 ||
    height === 0 ||
    (width <= UPLOAD_MAX_EDGE_PX && height <= UPLOAD_MAX_EDGE_PX)
  ) {
    return bytes;
  }

  return sharp(bytes)
    .resize({
      width: UPLOAD_MAX_EDGE_PX,
      height: UPLOAD_MAX_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/**
 * Thrown when an image can't be cropped (no metadata, too small, etc.).
 * Caller should record-and-skip — do not let one bad image take out
 * the batch.
 */
export class ImageCropError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageCropError";
  }
}
