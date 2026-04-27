/**
 * Cron: embed-card-art-crops
 *
 * Walks canonical_cards in slug order, generates an art-only crop of
 * each card's mirrored reference image (via lib/ai/image-crops), uploads
 * the crop to card-images/art-crops/<slug>.jpg, embeds the crop via
 * Replicate, and inserts a row into card_image_embeddings with
 * (variant_index=0, crop_type='art').
 *
 * Companion to the existing augment cron: where augmentations vary the
 * appearance of the full card to teach CLIP iPhone-like distributions,
 * this cron produces ONE additional region-cropped variant per card so
 * the inference path can run a parallel kNN against an art-only
 * reference subset. The two paths are merged max-by-slug at query time
 * — the result survives bottom-corner finger occlusion (the failure
 * mode that drove this work; see docs/scanner-augmentation-playbook.md).
 *
 * Idempotent: source_hash = sha256(model_version + recipe_version +
 * mirrored_url). If any of those change the row re-embeds; otherwise
 * skip. Safe to re-run. Bounded by maxCards so a single invocation
 * stays inside Vercel's 300s ceiling even with Replicate cold starts.
 *
 * Trust: cron — bearer CRON_SECRET.
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  hasVercelPostgresConfig,
  ensureCardImageEmbeddingsSchema,
} from "@/lib/ai/card-image-embeddings";
import {
  getReplicateClipEmbedder,
  hasReplicateConfig,
  ImageEmbedderConfigError,
  ImageEmbedderRuntimeError,
} from "@/lib/ai/image-embedder";
import {
  ART_CROP_RECIPE_VERSION,
  artCropTransform,
  ImageCropError,
} from "@/lib/ai/image-crops";

export const runtime = "nodejs";
export const maxDuration = 300;

const IMAGE_BUCKET = "card-images";
const ART_CROP_PREFIX = "art-crops";
const FETCH_BATCH_SIZE = 16;
const DEFAULT_MAX_CARDS = 64;
const MAX_CARDS_LIMIT = 256;
const DEADLINE_RESERVE_MS = 30_000;

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

type ExistingArtCropHash = {
  canonical_slug: string;
  source_hash: string;
};

/** TCG Pocket detection — same heuristic the augment cron uses. */
function isDigitalOnlyUrl(primaryImageUrl: string | null | undefined): boolean {
  if (!primaryImageUrl) return false;
  return primaryImageUrl.includes("/pokemon/tcgp-");
}

function parseMaxCards(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CARDS;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

function hashForArtCrop(params: {
  modelVersion: string;
  mirroredUrl: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(`${params.modelVersion}\n${ART_CROP_RECIPE_VERSION}\n${params.mirroredUrl}`)
    .digest("hex");
}

function artCropStorageKey(slug: string): string {
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `${ART_CROP_PREFIX}/${safeSlug}.jpg`;
}

/**
 * Fetch the "user attention" slug set for a focused recovery run.
 *
 * Same intersection we use for the card-profile selective recovery:
 * cards that have BEEN VIEWED in the last 14 days AND are PRICED at
 * $5+. The two filters together describe "cards a user has actually
 * looked at recently AND that are valuable enough that an AI summary
 * (or a high-quality multi-crop ensemble) is worth the cost."
 *
 * This is NOT the union — the union pulls in cheap cards that get
 * casual-discovery views, which dilutes the budget without helping.
 * The intersection lands at ~1,168 slugs against the current
 * catalog (2026-04-27).
 *
 * Returns an alphabetically-sorted array so the existing cursor-
 * advancement pattern works unchanged. The cron's cursor becomes an
 * index into this sorted set instead of into the full catalog.
 */
async function fetchAttentionSlugs(
  supabase: ReturnType<typeof dbAdmin>,
): Promise<string[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 14);
  const sinceDate = since.toISOString().slice(0, 10);

  const [viewedRes, pricedRes] = await Promise.all([
    supabase
      .from("public_card_page_view_daily")
      .select("canonical_slug")
      .gte("view_date", sinceDate),
    supabase
      .from("card_metrics")
      .select("canonical_slug")
      .is("printing_id", null)
      .eq("grade", "RAW")
      .gte("market_price", 5),
  ]);

  if (viewedRes.error) {
    throw new Error(`fetchAttentionSlugs viewed: ${viewedRes.error.message}`);
  }
  if (pricedRes.error) {
    throw new Error(`fetchAttentionSlugs priced: ${pricedRes.error.message}`);
  }

  const viewedSet = new Set<string>(
    (viewedRes.data ?? []).map((r) => (r as { canonical_slug: string }).canonical_slug),
  );
  const pricedSet = new Set<string>(
    (pricedRes.data ?? []).map((r) => (r as { canonical_slug: string }).canonical_slug),
  );
  // Intersection. JS doesn't have a built-in for this on Set yet
  // (Set.prototype.intersection is Stage 4 but not everywhere) so
  // do it explicitly.
  const intersection: string[] = [];
  for (const slug of viewedSet) {
    if (pricedSet.has(slug)) intersection.push(slug);
  }
  intersection.sort();
  return intersection;
}

async function fetchExistingArtCropHashes(slugs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (slugs.length === 0) return out;
  const result = await sql.query<ExistingArtCropHash>(
    `
      select canonical_slug, source_hash
      from card_image_embeddings
      where canonical_slug = any($1::text[])
        and crop_type = 'art'
        and variant_index = 0
    `,
    [slugs],
  );
  for (const row of result.rows) {
    out.set(row.canonical_slug, row.source_hash);
  }
  return out;
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

  const startedAt = Date.now();
  const deadline = startedAt + maxDuration * 1000 - DEADLINE_RESERVE_MS;

  const { searchParams } = new URL(req.url);
  const maxCards = parseMaxCards(searchParams.get("maxCards"));
  const cursor = searchParams.get("cursor") ?? "";
  // priority=attention_only: only embed art crops for the user-
  // attention subset (viewed in 14d AND priced ≥ $5). Bounds the
  // recovery spend at ~$1.75 instead of ~$5-10 for the full catalog,
  // and aligns the multi-crop coverage with the slugs the LLM-
  // summary recovery already prioritized. See
  // fetchAttentionSlugs above for the exact filter.
  const priority = searchParams.get("priority");
  const attentionOnly = priority === "attention_only";

  await ensureCardImageEmbeddingsSchema();

  const supabase = dbAdmin();
  let processed = 0;
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  let cropFailed = 0;
  let lastSlug: string | null = cursor || null;
  let truncatedAtDeadline = false;
  let firstFailure: string | null = null;

  // Attention mode: precompute the candidate slug set up front.
  // The cursor (if any) advances through this sorted list rather
  // than the full canonical_cards table, so each invocation walks
  // only "slugs we care about" instead of skipping past tens of
  // thousands of long-tail cards to find the next one to process.
  let attentionSlugs: string[] | null = null;
  let attentionStartIndex = 0;
  if (attentionOnly) {
    try {
      attentionSlugs = await fetchAttentionSlugs(supabase);
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
    if (lastSlug) {
      // Resume past the cursor — find the first attention slug
      // strictly greater than lastSlug.
      while (
        attentionStartIndex < attentionSlugs.length &&
        attentionSlugs[attentionStartIndex] <= lastSlug
      ) {
        attentionStartIndex += 1;
      }
    }
  }

  while (processed < maxCards) {
    if (Date.now() >= deadline) {
      truncatedAtDeadline = true;
      break;
    }
    const remaining = maxCards - processed;
    const pageSize = Math.min(FETCH_BATCH_SIZE, remaining);

    let rows: CanonicalRow[];
    if (attentionSlugs) {
      // Attention mode: page through the precomputed slug list.
      // Exhausted? Done.
      if (attentionStartIndex >= attentionSlugs.length) break;
      const pageSlugs = attentionSlugs.slice(
        attentionStartIndex,
        attentionStartIndex + pageSize,
      );
      attentionStartIndex += pageSlugs.length;

      const { data, error } = await supabase
        .from("canonical_cards")
        .select(
          "slug, canonical_name, language, set_name, card_number, variant, mirrored_primary_image_url, primary_image_url",
        )
        .in("slug", pageSlugs)
        .not("mirrored_primary_image_url", "is", null)
        .order("slug", { ascending: true });
      if (error) {
        return NextResponse.json(
          { ok: false, error: `canonical_cards select: ${error.message}` },
          { status: 500 },
        );
      }
      rows = (data ?? []) as CanonicalRow[];
      // It's possible some pageSlugs have null mirrored URLs and
      // get filtered out — that's fine, just skip them. Empty page
      // shouldn't end the drain because more attention slugs may
      // still be ahead.
      if (rows.length === 0) {
        // Advance cursor to the last slug we ASKED for so we don't
        // re-page these on retry.
        if (pageSlugs.length > 0) {
          lastSlug = pageSlugs[pageSlugs.length - 1];
        }
        continue;
      }
    } else {
      // Default mode: alphabetical pagination over canonical_cards.
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
      rows = (data ?? []) as CanonicalRow[];
      if (rows.length === 0) break;
    }

    const slugs = rows.map((r) => r.slug);
    const existingHashes = await fetchExistingArtCropHashes(slugs);

    for (const row of rows) {
      // Inner deadline check so a slow Replicate call near the
      // budget can't push the function past maxDuration. Same pattern
      // as the card-profile cron after commit cbddb8b.
      if (Date.now() >= deadline) {
        truncatedAtDeadline = true;
        break;
      }

      processed += 1;
      lastSlug = row.slug;

      if (!row.mirrored_primary_image_url) continue;

      const expectedHash = hashForArtCrop({
        modelVersion: embedder.modelVersion,
        mirroredUrl: row.mirrored_primary_image_url,
      });

      if (existingHashes.get(row.slug) === expectedHash) {
        skipped += 1;
        continue;
      }

      try {
        // 1. Fetch the original mirrored reference image bytes.
        const sourceResp = await fetch(row.mirrored_primary_image_url);
        if (!sourceResp.ok) {
          failed += 1;
          if (!firstFailure) firstFailure = `fetch-source:${row.slug}:${sourceResp.status}`;
          console.warn(
            `[art-crop] ${row.slug}: fetch source ${row.mirrored_primary_image_url} → ${sourceResp.status}`,
          );
          continue;
        }
        const sourceBuf = Buffer.from(await sourceResp.arrayBuffer());

        // 2. Apply the art-crop transform. Crop errors are recorded-
        // and-skipped — one undersized image shouldn't take out the
        // batch.
        let croppedBuf: Buffer;
        try {
          croppedBuf = await artCropTransform(sourceBuf);
        } catch (err) {
          cropFailed += 1;
          if (!firstFailure) {
            firstFailure = `crop:${row.slug}:${err instanceof Error ? err.message : String(err)}`;
          }
          console.warn(
            `[art-crop] ${row.slug}: crop failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }

        // 3. Upload to Supabase Storage with long cache (the crop
        // bytes are deterministic for a given source image + recipe).
        const storageKey = artCropStorageKey(row.slug);
        const { error: uploadErr } = await supabase.storage
          .from(IMAGE_BUCKET)
          .upload(storageKey, croppedBuf, {
            upsert: true,
            contentType: "image/jpeg",
            cacheControl: "31536000, immutable",
          });
        if (uploadErr) {
          failed += 1;
          if (!firstFailure) firstFailure = `upload:${row.slug}:${uploadErr.message}`;
          console.warn(`[art-crop] ${row.slug}: upload failed: ${uploadErr.message}`);
          continue;
        }
        const publicUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(storageKey).data.publicUrl;

        // 4. Embed via Replicate. Same model_version as the full-card
        // index so the two are queryable in the same embedding space.
        const embedResults = await embedder.embedUrls([publicUrl]);
        const first = embedResults[0];
        if (!first || first.embedding === null) {
          failed += 1;
          const reason = first?.error ?? "no result";
          if (!firstFailure) firstFailure = `embed:${row.slug}:${reason}`;
          console.warn(`[art-crop] ${row.slug}: embed returned null (${reason})`);
          continue;
        }

        // 5. Upsert into card_image_embeddings as
        // (slug, variant_index=0, crop_type='art').
        const vectorLiteral = `[${first.embedding.join(",")}]`;
        const isDigital = isDigitalOnlyUrl(row.primary_image_url);
        await sql.query(
          `
            insert into card_image_embeddings (
              canonical_slug, canonical_name, language, set_name, card_number, variant,
              source_image_url, source_hash, model_version, embedding, variant_index,
              is_digital_only, crop_type, updated_at
            ) values (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, 0, $11, 'art', now()
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
            isDigital,
          ],
        );
        generated += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof ImageEmbedderRuntimeError) {
          if (!firstFailure) firstFailure = `embedder-runtime:${row.slug}:${err.message}`;
          console.warn(`[art-crop] ${row.slug}: embedder runtime err: ${err.message}`);
          continue;
        }
        if (err instanceof ImageCropError) {
          // Should already be caught above, but defense-in-depth.
          cropFailed += 1;
          if (!firstFailure) firstFailure = `crop-late:${row.slug}:${err.message}`;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (!firstFailure) firstFailure = `unexpected:${row.slug}:${msg}`;
        console.warn(`[art-crop] ${row.slug}: unexpected err: ${msg}`);
      }
    }

    if (truncatedAtDeadline) break;
    // "Catalog exhausted" signal:
    //   - attention mode: handled at top of loop via attentionStartIndex
    //   - default mode: a short page from canonical_cards means we
    //     reached the end of the alphabetical walk
    if (!attentionSlugs && rows.length < pageSize) break;
  }

  return NextResponse.json({
    ok: true,
    job: "embed_card_art_crops",
    processed,
    generated,
    skipped,
    failed,
    crop_failed: cropFailed,
    first_failure: firstFailure,
    last_slug: lastSlug,
    max_cards: maxCards,
    durationMs: Date.now() - startedAt,
    truncatedAtDeadline,
    recipe_version: ART_CROP_RECIPE_VERSION,
    model_version: embedder.modelVersion,
    crop_type: "art",
    // Echoed back so the operator's drain loop can confirm it ran
    // in the mode it intended.
    priority: priority ?? null,
    attention_total: attentionSlugs?.length ?? null,
    attention_position: attentionSlugs ? attentionStartIndex : null,
  });
}
