/**
 * v1.1 auto-learning: turn a user's scan-correction into a kNN anchor.
 *
 * When a user taps "Not this card?" or picks via the picker-search
 * flow, the promote route lands a row in scan_eval_images (labeled
 * training data for Stage D fine-tuning) AND fires this helper, which
 * embeds the user's actual scan image with the current CLIP model and
 * inserts it into card_image_embeddings with `source = 'user_correction'`.
 *
 * Future kNN searches in /api/scan/identify treat these anchors
 * identically to catalog-art anchors. Effect: a card scanned in
 * difficult conditions (sleeve, glare, hand-occlusion) that needed
 * manual correction once will be recognized correctly the next time
 * a similar image arrives — no model retraining needed in the
 * intermediate term.
 *
 * This is a CACHE between the static catalog and the eventual
 * Stage D retraining. When retraining lands, the model itself
 * generalizes from these corrections; we'd then re-embed the
 * user_correction rows under the new model_version (or discard them
 * — see docs/scanner-finetune-runbook.md).
 *
 * Trust model: only fired from the admin-gated /api/admin/scan-eval/promote
 * route. Untrusted users cannot directly write to card_image_embeddings.
 *
 * Cost: ~$0.001/correction (one Replicate CLIP call) + ~50 KB row.
 * Negligible at the volumes we expect (target: hundreds/day).
 */

import { sql } from "@vercel/postgres";
import {
  ensureCardImageEmbeddingsSchema,
  IMAGE_EMBED_USER_CORRECTION_VARIANT_OFFSET,
} from "./card-image-embeddings";
import { getReplicateClipEmbedder } from "./image-embedder";
import { dbAdmin } from "@/lib/db/admin";

/**
 * Embed `imageBytes` with the current model and persist as a kNN
 * anchor for `canonicalSlug`. Idempotent: a re-call with the same
 * (canonicalSlug, source_hash, model_version) is a no-op.
 *
 * Throws on hard failures (embed RPC error, DB error). The caller
 * (promote route) wraps this in a fire-and-forget so failures here
 * never block the user-visible promote response.
 */
export async function embedAndStoreUserCorrection(args: {
  imageBytes: Buffer;
  imageHash: string;
  canonicalSlug: string;
  /** "image/jpeg" — bytes are always JPEG by the time the promote
   *  route resizes via resizeForUpload. */
  mimeType?: string;
}): Promise<{ skipped: boolean; variantIndex: number; modelVersion: string }> {
  const mimeType = args.mimeType ?? "image/jpeg";

  await ensureCardImageEmbeddingsSchema();

  const embedder = getReplicateClipEmbedder();

  // 1. Pull canonical metadata for this slug. We need canonical_name +
  //    set_name + card_number for the row insert (kNN response shape
  //    expects these populated). If the slug doesn't exist in
  //    canonical_cards, abort — we don't want orphaned anchors.
  const slugRow = await dbAdmin()
    .from("canonical_cards")
    .select("canonical_name, language, set_name, card_number, variant, mirrored_primary_image_url")
    .eq("slug", args.canonicalSlug)
    .maybeSingle();
  if (slugRow.error) {
    throw new Error(
      `[user-correction-embed] canonical_cards lookup failed for ${args.canonicalSlug}: ${slugRow.error.message}`,
    );
  }
  if (!slugRow.data) {
    throw new Error(
      `[user-correction-embed] no canonical_cards row for slug=${args.canonicalSlug} — refusing to insert orphan anchor`,
    );
  }

  // 2. Idempotency check: if we've already embedded this exact image
  //    for this slug under the current model_version, no-op. Saves a
  //    Replicate call and avoids variant_index churn on re-promotes.
  const existing = await sql.query<{ variant_index: number }>(
    `select variant_index
     from card_image_embeddings
     where canonical_slug = $1
       and source_hash = $2
       and model_version = $3
       and source = 'user_correction'
     limit 1`,
    [args.canonicalSlug, args.imageHash, embedder.modelVersion],
  );
  if (existing.rows.length > 0) {
    return {
      skipped: true,
      variantIndex: existing.rows[0].variant_index,
      modelVersion: embedder.modelVersion,
    };
  }

  // 3. Embed. fail-fast on transport errors (the user-visible promote
  //    has already succeeded; we just don't get the v1.1 cache benefit
  //    on this one correction).
  const embedding = await embedder.embedBytes(args.imageBytes, mimeType);

  // 4. Pick the next variant_index for user-correction rows on this
  //    slug. Catalog rows live at 0 + small ints (Stage C aug). User
  //    corrections start at IMAGE_EMBED_USER_CORRECTION_VARIANT_OFFSET
  //    so the two populations never collide on PK.
  const maxResult = await sql.query<{ next_index: number }>(
    `select coalesce(max(variant_index), $2 - 1) + 1 as next_index
     from card_image_embeddings
     where canonical_slug = $1
       and variant_index >= $2`,
    [args.canonicalSlug, IMAGE_EMBED_USER_CORRECTION_VARIANT_OFFSET],
  );
  const variantIndex = maxResult.rows[0]?.next_index ?? IMAGE_EMBED_USER_CORRECTION_VARIANT_OFFSET;

  // 5. Insert. ON CONFLICT DO NOTHING handles the (rare) race where
  //    two concurrent corrections of the same image+slug landed at the
  //    same time (idempotency check missed it because both saw "no
  //    existing row"). One wins, the other is a harmless duplicate
  //    attempt the index rejects.
  const sourceImageUrl = `supabase://card-images/scan-eval/${args.imageHash}.jpg`;
  await sql.query(
    `insert into card_image_embeddings (
       canonical_slug,
       canonical_name,
       language,
       set_name,
       card_number,
       variant,
       source_image_url,
       source_hash,
       model_version,
       embedding,
       variant_index,
       crop_type,
       source,
       updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11, 'full', 'user_correction', now())
     on conflict (canonical_slug, variant_index, crop_type) do nothing`,
    [
      args.canonicalSlug,
      slugRow.data.canonical_name,
      slugRow.data.language,
      slugRow.data.set_name,
      slugRow.data.card_number,
      slugRow.data.variant,
      sourceImageUrl,
      args.imageHash,
      embedder.modelVersion,
      `[${embedding.join(",")}]`,
      variantIndex,
    ],
  );

  return {
    skipped: false,
    variantIndex,
    modelVersion: embedder.modelVersion,
  };
}
