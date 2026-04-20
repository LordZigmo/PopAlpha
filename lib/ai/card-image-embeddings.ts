/**
 * card_image_embeddings — Neon pgvector store of CLIP image embeddings
 * for every canonical card whose provider image we have mirrored into
 * Supabase Storage.
 *
 * Flow mirrors lib/ai/card-embeddings.ts (text embeddings):
 *   1. `ensureCardImageEmbeddingsSchema` creates table + indexes lazily.
 *   2. `fetchExistingEmbeddingHashes` reads source_hash per slug.
 *   3. `refreshCardImageEmbeddingBatch` embeds rows whose hash changed
 *      and upserts the vectors.
 *
 * The source_hash binds a card's mirrored image URL to the embedder
 * model_version. Rotating the model invalidates every row without
 * touching the ingestion code — the next cron pass re-embeds.
 */

import crypto from "node:crypto";
import { sql } from "@vercel/postgres";
import { hasVercelPostgresConfig } from "@/lib/ai/card-embeddings";
import {
  IMAGE_EMBEDDER_DIMENSIONS,
  type ImageEmbedder,
} from "@/lib/ai/image-embedder";

export { hasVercelPostgresConfig };

export type EmbeddableCardImage = {
  slug: string;
  canonical_name: string;
  language: string | null;
  set_name: string | null;
  card_number: string | null;
  variant: string | null;
  /** The URL we feed the embedder — typically mirrored_primary_image_url. */
  source_image_url: string;
};

type ExistingHashRow = {
  canonical_slug: string;
  source_hash: string;
};

export function buildImageEmbeddingHash(
  card: EmbeddableCardImage,
  modelVersion: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`${modelVersion}\n${card.source_image_url}`)
    .digest("hex");
}

export async function ensureCardImageEmbeddingsSchema(): Promise<void> {
  if (!hasVercelPostgresConfig()) {
    throw new Error(
      "Missing Vercel Postgres connection string. Set POSTGRES_URL or a compatible alternate env.",
    );
  }

  await sql.query(`create extension if not exists vector;`);
  await sql.query(`
    create table if not exists card_image_embeddings (
      canonical_slug text primary key,
      canonical_name text not null,
      language text null,
      set_name text null,
      card_number text null,
      variant text null,
      source_image_url text not null,
      source_hash text not null,
      model_version text not null,
      embedding vector(${IMAGE_EMBEDDER_DIMENSIONS}) not null,
      updated_at timestamptz not null default now()
    );
  `);

  // Prefilter btree indexes. kNN queries from the identify route will
  // WHERE on language (and optionally set_name) before the vector scan,
  // so the planner needs these.
  await sql.query(`
    create index if not exists card_image_embeddings_language_idx
      on card_image_embeddings (language);
  `);
  await sql.query(`
    create index if not exists card_image_embeddings_set_name_idx
      on card_image_embeddings (set_name);
  `);
  await sql.query(`
    create index if not exists card_image_embeddings_model_version_idx
      on card_image_embeddings (model_version);
  `);

  // HNSW cosine index — fits our similarity model (unit-normalized CLIP
  // embeddings, approximate kNN). Build parameters left at pgvector
  // defaults; revisit once the table has tens of thousands of rows.
  await sql.query(`
    create index if not exists card_image_embeddings_embedding_hnsw_cosine_idx
      on card_image_embeddings
      using hnsw (embedding vector_cosine_ops);
  `);
}

export async function fetchExistingImageEmbeddingHashes(
  slugs: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (slugs.length === 0) return out;

  const result = await sql.query<ExistingHashRow>(
    "select canonical_slug, source_hash from card_image_embeddings where canonical_slug = any($1::text[])",
    [slugs],
  );

  for (const row of result.rows) {
    out.set(row.canonical_slug, row.source_hash);
  }

  return out;
}

export type ImageEmbeddingBatchResult = {
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Slugs whose vectors were successfully upserted in this batch. */
  successSlugs: string[];
  /**
   * Per-slug failure reasons — fed into canonical_cards.image_embed_*
   * tracking columns by the cron route so we back off known-broken URLs.
   */
  failureReasons: Array<{ slug: string; error: string }>;
};

/**
 * Embed the rows whose (model_version, source_image_url) hash changed
 * and upsert their vectors. Rows whose hash matches are left untouched.
 */
export async function refreshCardImageEmbeddingBatch(
  cards: EmbeddableCardImage[],
  embedder: ImageEmbedder,
): Promise<ImageEmbeddingBatchResult> {
  if (cards.length === 0) {
    return {
      processed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      successSlugs: [],
      failureReasons: [],
    };
  }

  await ensureCardImageEmbeddingsSchema();

  const existingHashes = await fetchExistingImageEmbeddingHashes(
    cards.map((card) => card.slug),
  );

  const changedCards: EmbeddableCardImage[] = [];
  const hashSkippedSlugs: string[] = [];
  for (const card of cards) {
    if (buildImageEmbeddingHash(card, embedder.modelVersion) !== existingHashes.get(card.slug)) {
      changedCards.push(card);
    } else {
      hashSkippedSlugs.push(card.slug);
    }
  }

  if (changedCards.length === 0) {
    // Every card in this batch is already correctly embedded in Neon.
    // They still count as successes from the cron's perspective so
    // canonical_cards.image_embedded_at gets stamped and they fall out
    // of future claim queries.
    return {
      processed: cards.length,
      updated: 0,
      skipped: cards.length,
      failed: 0,
      successSlugs: hashSkippedSlugs,
      failureReasons: [],
    };
  }

  const urls = changedCards.map((card) => card.source_image_url);
  const results = await embedder.embedUrls(urls);

  let updated = 0;
  let failed = 0;
  const successSlugs: string[] = [];
  const failureReasons: Array<{ slug: string; error: string }> = [];

  for (let index = 0; index < changedCards.length; index += 1) {
    const card = changedCards[index]!;
    const result = results[index];
    if (!result || result.embedding === null) {
      // URL-level embed failure. Count it as failed and surface the
      // reason so the caller (cron route) can bump the attempts counter
      // on canonical_cards and back off on known-broken URLs.
      failed += 1;
      failureReasons.push({
        slug: card.slug,
        error: result?.error ?? "embedder returned no result",
      });
      continue;
    }

    const embedding = result.embedding;
    const vectorLiteral = `[${embedding.join(",")}]`;
    const sourceHash = buildImageEmbeddingHash(card, embedder.modelVersion);

    try {
      await sql.query(
        `
          insert into card_image_embeddings (
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
            updated_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, now()
          )
          on conflict (canonical_slug) do update set
            canonical_name = excluded.canonical_name,
            language = excluded.language,
            set_name = excluded.set_name,
            card_number = excluded.card_number,
            variant = excluded.variant,
            source_image_url = excluded.source_image_url,
            source_hash = excluded.source_hash,
            model_version = excluded.model_version,
            embedding = excluded.embedding,
            updated_at = excluded.updated_at
        `,
        [
          card.slug,
          card.canonical_name,
          card.language,
          card.set_name,
          card.card_number,
          card.variant,
          card.source_image_url,
          sourceHash,
          embedder.modelVersion,
          vectorLiteral,
        ],
      );
      updated += 1;
      successSlugs.push(card.slug);
    } catch (err) {
      // SQL insert failure is infra-level (Neon hiccup), not a broken
      // source URL. We still surface it so the operator sees something,
      // but the cron route uses a separate code path for non-URL
      // failures that shouldn't burn the attempts budget.
      failed += 1;
      failureReasons.push({
        slug: card.slug,
        error: err instanceof Error ? `pgvector upsert: ${err.message.slice(0, 500)}` : "pgvector upsert failed",
      });
    }
  }

  return {
    processed: cards.length,
    updated,
    skipped: hashSkippedSlugs.length,
    failed,
    // Include both paths to "currently valid in Neon": the ones we just
    // upserted AND the ones whose hash already matched.
    successSlugs: [...successSlugs, ...hashSkippedSlugs],
    failureReasons,
  };
}
