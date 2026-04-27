/**
 * Cron: augment-card-image-embeddings (Stage C)
 *
 * Walks canonical_cards in slug order, generates a small number of
 * synthetic "iPhone-like" augmentations of each mirrored reference
 * image (see lib/ai/image-augmentations), uploads each augmented
 * variant into card-images/augmented/<slug>/v<index>.jpg, embeds the
 * variant via Replicate, and inserts a new row into Neon's
 * card_image_embeddings keyed by (canonical_slug, variant_index).
 *
 * Each row under the same canonical_slug represents a different
 * "view" of the same card in CLIP space. The identify route's kNN
 * dedups by canonical_slug so the closest matching variant per card
 * is what surfaces.
 *
 * Idempotency: source_hash = sha256(model_version + recipe_id +
 * mirrored_url). If any of those change (recipe bump, model swap,
 * new mirror URL), the row re-embeds on next cron pass. Already-
 * current rows skip.
 *
 * Safe to re-run. Bounded by maxCards so no single invocation blows
 * the 300s Vercel limit with Replicate cold-start latency.
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { hasVercelPostgresConfig, ensureCardImageEmbeddingsSchema } from "@/lib/ai/card-image-embeddings";
import {
  getReplicateClipEmbedder,
  hasReplicateConfig,
  ImageEmbedderConfigError,
  ImageEmbedderRuntimeError,
} from "@/lib/ai/image-embedder";
import {
  AUGMENTATION_RECIPE_VERSION,
  AUGMENTATION_VARIANTS,
  type AugmentationVariant,
} from "@/lib/ai/image-augmentations";

export const runtime = "nodejs";
export const maxDuration = 300;

const IMAGE_BUCKET = "card-images";
const AUGMENTED_PREFIX = "augmented";
const FETCH_BATCH_SIZE = 16;
const DEFAULT_MAX_CARDS = 64;
const MAX_CARDS_LIMIT = 256;

type CanonicalRow = {
  slug: string;
  canonical_name: string;
  language: string | null;
  set_name: string | null;
  card_number: string | null;
  variant: string | null;
  mirrored_primary_image_url: string | null;
  primary_image_url: string | null;
};

/** Detects TCG Pocket (digital-only) cards by their Scrydex URL prefix. */
function isDigitalOnlyUrl(primaryImageUrl: string | null | undefined): boolean {
  if (!primaryImageUrl) return false;
  return primaryImageUrl.includes("/pokemon/tcgp-");
}

type ExistingVariantHash = {
  canonical_slug: string;
  variant_index: number;
  source_hash: string;
};

function parseMaxCards(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CARDS;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

function hashForVariant(params: {
  modelVersion: string;
  recipeId: string;
  mirroredUrl: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(`${params.modelVersion}\n${AUGMENTATION_RECIPE_VERSION}\n${params.recipeId}\n${params.mirroredUrl}`)
    .digest("hex");
}

function augmentedStorageKey(slug: string, variant: AugmentationVariant): string {
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `${AUGMENTED_PREFIX}/${safeSlug}/v${variant.index}-${variant.recipeId}.jpg`;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  if (!hasVercelPostgresConfig()) {
    return NextResponse.json(
      { ok: false, error: "Missing Vercel Postgres connection string." },
      { status: 500 },
    );
  }

  const { searchParams: querySearchParams } = new URL(req.url);

  // `?backfill=1` path: skip the normal augment work, just mark all
  // TCG Pocket rows in card_image_embeddings with is_digital_only=true
  // so the identify route's kNN filter excludes them. Folded into this
  // already-classified cron to avoid the middleware-bundle-cache
  // latency that blocks adding a new cron route mid-session. One-shot
  // and idempotent.
  if (querySearchParams.get("backfill") === "1") {
    return await runDigitalFlagBackfill();
  }

  if (!hasReplicateConfig()) {
    return NextResponse.json(
      { ok: false, error: "Missing REPLICATE_API_TOKEN or REPLICATE_CLIP_MODEL_VERSION." },
      { status: 500 },
    );
  }

  let embedder;
  try {
    embedder = getReplicateClipEmbedder();
  } catch (err) {
    if (err instanceof ImageEmbedderConfigError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
    }
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const maxCards = parseMaxCards(searchParams.get("maxCards"));
  const cursor = searchParams.get("cursor") ?? "";

  // Ensure the new schema (composite PK, variant_index column) exists
  // before any upsert attempts.
  await ensureCardImageEmbeddingsSchema();

  const supabase = dbAdmin();
  let processed = 0;
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  let lastSlug: string | null = cursor || null;

  while (processed < maxCards) {
    const remaining = maxCards - processed;
    const pageSize = Math.min(FETCH_BATCH_SIZE, remaining);

    let query = supabase
      .from("canonical_cards")
      .select(
        "slug, canonical_name, language, set_name, card_number, variant, mirrored_primary_image_url, primary_image_url",
      )
      .not("mirrored_primary_image_url", "is", null)
      .order("slug", { ascending: true })
      .limit(pageSize);

    if (lastSlug) query = query.gt("slug", lastSlug);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json(
        { ok: false, error: `canonical_cards select: ${error.message}` },
        { status: 500 },
      );
    }
    const rows = (data ?? []) as CanonicalRow[];
    if (rows.length === 0) break;

    const slugs = rows.map((r) => r.slug);
    const existingHashes = await fetchExistingVariantHashes(slugs);

    for (const row of rows) {
      processed += 1;
      lastSlug = row.slug;

      if (!row.mirrored_primary_image_url) continue;

      for (const variant of AUGMENTATION_VARIANTS) {
        const expectedHash = hashForVariant({
          modelVersion: embedder.modelVersion,
          recipeId: variant.recipeId,
          mirroredUrl: row.mirrored_primary_image_url,
        });

        const existingKey = `${row.slug}::${variant.index}`;
        if (existingHashes.get(existingKey) === expectedHash) {
          skipped += 1;
          continue;
        }

        try {
          // 1. Fetch the original mirrored reference image.
          const sourceResp = await fetch(row.mirrored_primary_image_url);
          if (!sourceResp.ok) {
            failed += 1;
            console.warn(
              `[augment] ${row.slug} v${variant.index}: fetch source ${row.mirrored_primary_image_url} → ${sourceResp.status}`,
            );
            continue;
          }
          const sourceBuf = Buffer.from(await sourceResp.arrayBuffer());

          // 2. Apply the variant's transform.
          const augmentedBuf = await variant.transform(sourceBuf);

          // 3. Upload to Supabase storage.
          const storageKey = augmentedStorageKey(row.slug, variant);
          const { error: uploadErr } = await supabase.storage
            .from(IMAGE_BUCKET)
            .upload(storageKey, augmentedBuf, {
              upsert: true,
              contentType: "image/jpeg",
              cacheControl: "31536000, immutable",
            });
          if (uploadErr) {
            failed += 1;
            console.warn(
              `[augment] ${row.slug} v${variant.index}: upload failed: ${uploadErr.message}`,
            );
            continue;
          }
          const publicUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(storageKey).data.publicUrl;

          // 4. Embed via Replicate.
          const embedResults = await embedder.embedUrls([publicUrl]);
          const first = embedResults[0];
          if (!first || first.embedding === null) {
            failed += 1;
            console.warn(
              `[augment] ${row.slug} v${variant.index}: embed returned null (${first?.error ?? "no result"})`,
            );
            continue;
          }

          // 5. Upsert into card_image_embeddings.
          const vectorLiteral = `[${first.embedding.join(",")}]`;
          const isDigital = isDigitalOnlyUrl(row.primary_image_url);
          // Augmented variants are full-card crops by construction
          // (color/rotation transforms, no region cropping). The
          // composite PK includes crop_type='full' explicitly so this
          // upsert touches the same row each run regardless of any
          // future art-crop rows under the same (slug, variant_index).
          await sql.query(
            `
              insert into card_image_embeddings (
                canonical_slug, canonical_name, language, set_name, card_number, variant,
                source_image_url, source_hash, model_version, embedding, variant_index,
                is_digital_only, crop_type, updated_at
              ) values (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11, $12, 'full', now()
              )
              on conflict (canonical_slug, variant_index, crop_type) do update set
                canonical_name = excluded.canonical_name,
                language = excluded.language,
                set_name = excluded.set_name,
                card_number = excluded.card_number,
                variant = excluded.variant,
                source_image_url = excluded.source_image_url,
                source_hash = excluded.source_hash,
                model_version = excluded.model_version,
                embedding = excluded.embedding,
                is_digital_only = excluded.is_digital_only,
                updated_at = excluded.updated_at
            `,
            [
              row.slug,
              row.canonical_name,
              row.language,
              row.set_name,
              row.card_number,
              row.variant,
              publicUrl,
              expectedHash,
              embedder.modelVersion,
              vectorLiteral,
              variant.index,
              isDigital,
            ],
          );
          generated += 1;
        } catch (err) {
          if (err instanceof ImageEmbedderRuntimeError) {
            failed += 1;
            console.warn(
              `[augment] ${row.slug} v${variant.index}: embedder runtime err: ${err.message}`,
            );
            continue;
          }
          failed += 1;
          console.warn(
            `[augment] ${row.slug} v${variant.index}: unexpected err: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (rows.length < pageSize) break;
  }

  return NextResponse.json({
    ok: true,
    processed,
    generated,
    skipped,
    failed,
    last_slug: lastSlug,
    max_cards: maxCards,
    recipe_version: AUGMENTATION_RECIPE_VERSION,
    model_version: embedder.modelVersion,
    variants_per_card: AUGMENTATION_VARIANTS.length,
  });
}

async function fetchExistingVariantHashes(slugs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (slugs.length === 0) return out;
  // Filter to crop_type='full' so we never confuse an augmented full-
  // card variant with an art-crop variant of the same slug. The
  // augment cron only ever produces crop_type='full' rows; the art-
  // crop cron lives at a separate route with its own hash query.
  const result = await sql.query<ExistingVariantHash>(
    `
      select canonical_slug, variant_index, source_hash
      from card_image_embeddings
      where canonical_slug = any($1::text[])
        and variant_index > 0
        and crop_type = 'full'
    `,
    [slugs],
  );
  for (const row of result.rows) {
    out.set(`${row.canonical_slug}::${row.variant_index}`, row.source_hash);
  }
  return out;
}

/**
 * One-shot cross-DB backfill invoked via ?backfill=1. Fetches the
 * set of TCG Pocket (digital-only) slugs from Supabase and flips
 * card_image_embeddings.is_digital_only to true for all matching
 * rows in Neon. Idempotent — the WHERE clause skips rows that are
 * already flagged, so re-runs are cheap no-ops.
 */
async function runDigitalFlagBackfill() {
  await ensureCardImageEmbeddingsSchema();

  const supabase = dbAdmin();
  const digitalSlugs: string[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug")
      .like("primary_image_url", "%/pokemon/tcgp-%")
      .range(offset, offset + PAGE - 1);
    if (error) {
      return NextResponse.json(
        { ok: false, error: `supabase select: ${error.message}` },
        { status: 500 },
      );
    }
    const rows = (data ?? []) as Array<{ slug: string }>;
    for (const row of rows) digitalSlugs.push(row.slug);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  if (digitalSlugs.length === 0) {
    return NextResponse.json({
      ok: true,
      backfill: true,
      digital_slugs_found: 0,
      rows_updated: 0,
      note: "No TCG Pocket slugs found in canonical_cards.",
    });
  }

  const updateResult = await sql.query(
    `
      update card_image_embeddings
      set is_digital_only = true,
          updated_at = now()
      where canonical_slug = any($1::text[])
        and is_digital_only = false
    `,
    [digitalSlugs],
  );

  const after = await sql.query<{ n: number }>(
    `select count(*)::int as n from card_image_embeddings where is_digital_only = true`,
  );

  return NextResponse.json({
    ok: true,
    backfill: true,
    digital_slugs_found: digitalSlugs.length,
    rows_updated: updateResult.rowCount ?? 0,
    total_digital_flagged_after: after.rows[0]?.n ?? 0,
  });
}
