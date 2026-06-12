/**
 * Cron: augment-card-image-embeddings (Stage C)
 *
 * Claims canonical_cards (slug order) that are MISSING augmented-
 * variant embedding rows under the ACTIVE embedder's model_version,
 * generates the synthetic "iPhone-like" augmentations of each
 * mirrored reference image (see lib/ai/image-augmentations), uploads
 * each variant to card-images/augmented/<slug>/, embeds it via the
 * ACTIVE embedder (getImageEmbedder — home-GPU SigLIP as of
 * 2026-06), and upserts rows into card_image_embeddings (Supabase)
 * keyed by (canonical_slug, variant_index, crop_type, model_version).
 *
 * Claim-based — no cursor watermark to persist: a slug is work iff
 * any of its AUGMENTATION_VARIANTS rows at (crop_type='full',
 * model_version=active) is MISSING or has a STALE source_hash (the
 * expected hash is computed in SQL via pgcrypto, parity-checked
 * against hashForVariant() every run). New cards, model cutovers,
 * recipe bumps, and mirrored-URL changes all backfill automatically;
 * a fully-current catalog makes the scheduled run a cheap indexed
 * no-op scan.
 *
 * History (2026-06-12 redesign): the previous version instantiated
 * the Replicate CLIP embedder directly while stamping rows with the
 * env-resolved ACTIVE tag — under IMAGE_EMBEDDER_VARIANT=modal-siglip
 * that wrote CLIP-space vectors labeled siglip2 into the live
 * candidate pool. It also restarted its query-param cursor at the
 * top of the catalog every scheduled run, re-examining (and on hash
 * mismatch re-embedding, via Replicate, every 5 minutes) the same
 * first ~32 slugs forever. Backend and tag now both come from
 * getImageEmbedder(), so they cannot disagree by construction.
 *
 * Modes:
 *   ?cursor=<slug>  manual drain start point (claim filter still
 *                   applies past it)
 *   ?reset=1        delete ALL augment rows under the active
 *                   model_version so scheduled claim runs rebuild
 *                   them cleanly. Still REQUIRED for the 2026-04/05
 *                   era repair even though the claim catches stale
 *                   hashes: the old cron computed source_hash with
 *                   the ACTIVE tag while embedding via CLIP, so those
 *                   rows carry correct-looking hashes over wrong-
 *                   space vectors — undetectable by hash comparison.
 *                   Run it once AFTER the embedder is healthy.
 *   ?backfill=1     one-shot TCG Pocket is_digital_only flag pass
 *
 * Idempotency: source_hash = sha256(model_version + recipe version +
 * recipe_id + mirrored_url); per-variant current rows skip. Bounded
 * by maxCards so no single invocation blows the 300s Vercel limit.
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { hasVercelPostgresConfig, ensureCardImageEmbeddingsSchema } from "@/lib/ai/card-image-embeddings";
import {
  getImageEmbedder,
  hasImageEmbedderConfig,
  IMAGE_EMBEDDER_MODEL_VERSION,
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

  const { searchParams } = new URL(req.url);

  // `?backfill=1` path: skip the normal augment work, just mark all
  // TCG Pocket rows in card_image_embeddings with is_digital_only=true
  // so the identify route's kNN filter excludes them. Folded into this
  // already-classified cron to avoid the middleware-bundle-cache
  // latency that blocks adding a new cron route mid-session. One-shot
  // and idempotent.
  if (searchParams.get("backfill") === "1") {
    return await runDigitalFlagBackfill();
  }

  // `?reset=1` path: drop every augment row under the active
  // model_version. The claim query then sees those slugs as missing
  // and scheduled runs re-embed them via the active embedder — the
  // one-shot repair for rows whose vectors/hashes predate the
  // 2026-06-12 redesign.
  if (searchParams.get("reset") === "1") {
    return await runAugmentReset();
  }

  if (!hasImageEmbedderConfig()) {
    return NextResponse.json(
      { ok: false, error: "Active image embedder is not configured (check IMAGE_EMBEDDER_VARIANT + its env)." },
      { status: 500 },
    );
  }

  let embedder;
  try {
    embedder = getImageEmbedder();
  } catch (err) {
    if (err instanceof ImageEmbedderConfigError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
    }
    throw err;
  }

  const maxCards = parseMaxCards(searchParams.get("maxCards"));
  const cursor = searchParams.get("cursor") ?? "";

  // Ensure the schema (composite PK, variant_index column) exists
  // before any upsert attempts.
  await ensureCardImageEmbeddingsSchema();

  const supabase = dbAdmin();
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  let lastSlug: string | null = cursor || null;

  // PARITY SELF-CHECK: the claim query below recomputes the expected
  // source_hash in SQL (extensions.digest). If that expression ever
  // drifts from hashForVariant() — string assembly, encoding, or
  // function semantics — every row looks permanently stale and the
  // cron re-embeds the catalog in an endless loop. Verify agreement
  // on a synthetic input each run and refuse to proceed on drift.
  const probe = {
    modelVersion: embedder.modelVersion,
    recipeId: "parity-probe",
    mirroredUrl: "https://parity.probe/img.jpg",
  };
  const parity = await sql.query<{ h: string }>(
    `select encode(extensions.digest($1 || chr(10) || $2 || chr(10) || $3 || chr(10) || $4, 'sha256'), 'hex') as h`,
    [probe.modelVersion, AUGMENTATION_RECIPE_VERSION, probe.recipeId, probe.mirroredUrl],
  );
  if (parity.rows[0]?.h !== hashForVariant(probe)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "SQL/JS source_hash parity check failed — the claim query's digest expression and hashForVariant() have drifted; refusing to run.",
      },
      { status: 500 },
    );
  }

  // Claim: mirrored cards where any augment variant row under the
  // active model_version is missing or hash-stale. canonical_cards
  // and card_image_embeddings live in the same database (Supabase —
  // the POSTGRES_URL pool), so this is one indexed query: the left
  // join probes the embeddings PK (canonical_slug, variant_index,
  // crop_type, model_version) per candidate slug × variant, and the
  // digest recomputes the expected source_hash so recipe bumps and
  // mirrored-URL changes are claimed without any cursor/watermark.
  const claim = await sql.query<CanonicalRow>(
    `
      with variants as (
        select * from unnest($4::int[], $5::text[]) as v(variant_index, recipe_id)
      )
      select c.slug, c.canonical_name, c.language, c.set_name, c.card_number, c.variant,
             c.mirrored_primary_image_url, c.primary_image_url
      from canonical_cards c
      where c.mirrored_primary_image_url is not null
        and ($2 = '' or c.slug > $2)
        and exists (
          select 1
          from variants v
          left join card_image_embeddings e
            on e.canonical_slug = c.slug
           and e.variant_index = v.variant_index
           and e.crop_type = 'full'
           and e.model_version = $1
          where e.canonical_slug is null
             or e.source_hash <> encode(
                  extensions.digest(
                    $1 || chr(10) || $3 || chr(10) || v.recipe_id || chr(10) || c.mirrored_primary_image_url,
                    'sha256'
                  ), 'hex')
        )
      order by c.slug
      limit $6
    `,
    [
      embedder.modelVersion,
      cursor,
      AUGMENTATION_RECIPE_VERSION,
      AUGMENTATION_VARIANTS.map((v) => v.index),
      AUGMENTATION_VARIANTS.map((v) => v.recipeId),
      maxCards,
    ],
  );
  const rows = claim.rows;
  const processed = rows.length;

  const slugs = rows.map((r) => r.slug);
  const existingHashes = await fetchExistingVariantHashes(slugs, embedder.modelVersion);

  for (const row of rows) {
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

        // 4. Embed via the active embedder.
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
            on conflict (canonical_slug, variant_index, crop_type, model_version) do update set
              canonical_name = excluded.canonical_name,
              language = excluded.language,
              set_name = excluded.set_name,
              card_number = excluded.card_number,
              variant = excluded.variant,
              source_image_url = excluded.source_image_url,
              source_hash = excluded.source_hash,
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

  return NextResponse.json({
    ok: true,
    processed,
    generated,
    skipped,
    failed,
    last_slug: lastSlug,
    max_cards: maxCards,
    claim_mode: "missing-or-stale-variant-rows",
    recipe_version: AUGMENTATION_RECIPE_VERSION,
    model_version: embedder.modelVersion,
    variants_per_card: AUGMENTATION_VARIANTS.length,
  });
}

async function fetchExistingVariantHashes(
  slugs: string[],
  modelVersion: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (slugs.length === 0) return out;
  // Scope to crop_type='full' AND the active model_version: the
  // augment cron only produces full-crop rows, and when two model
  // generations coexist (CLIP rollback rows + SigLIP) an unscoped
  // query returns one of the two source_hashes nondeterministically.
  const result = await sql.query<ExistingVariantHash>(
    `
      select canonical_slug, variant_index, source_hash
      from card_image_embeddings
      where canonical_slug = any($1::text[])
        and variant_index > 0
        and variant_index < 10000
        and crop_type = 'full'
        and model_version = $2
    `,
    [slugs, modelVersion],
  );
  for (const row of result.rows) {
    out.set(`${row.canonical_slug}::${row.variant_index}`, row.source_hash);
  }
  return out;
}

/**
 * One-shot repair invoked via ?reset=1. Deletes every augmented-
 * variant row (0 < variant_index < 10000, crop_type='full') under
 * the ACTIVE model_version; the scheduled claim runs then rebuild
 * them via the active embedder. Must survive untouched: catalog rows
 * (variant_index 0), art crops (crop_type='art'), and user-correction
 * anchors (variant_index >= 10000 — additionally excluded by source
 * as belt-and-braces, since they are real user signal that cannot be
 * regenerated from reference images).
 */
async function runAugmentReset() {
  await ensureCardImageEmbeddingsSchema();

  const result = await sql.query(
    `
      delete from card_image_embeddings
      where variant_index > 0
        and variant_index < 10000
        and crop_type = 'full'
        and model_version = $1
        and (source is null or source <> 'user_correction')
    `,
    [IMAGE_EMBEDDER_MODEL_VERSION],
  );

  return NextResponse.json({
    ok: true,
    reset: true,
    model_version: IMAGE_EMBEDDER_MODEL_VERSION,
    rows_deleted: result.rowCount ?? 0,
    note: "Scheduled claim runs will re-generate augments from scratch via the active embedder.",
  });
}

/**
 * One-shot backfill invoked via ?backfill=1. Fetches the set of TCG
 * Pocket (digital-only) slugs from canonical_cards and flips
 * card_image_embeddings.is_digital_only to true for all matching
 * rows (both tables live in Supabase). Idempotent — the WHERE clause
 * skips rows that are already flagged, so re-runs are cheap no-ops.
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
