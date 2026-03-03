import crypto from "node:crypto";
import { embedMany } from "ai";
import { sql } from "@vercel/postgres";
import { getPopAlphaEmbeddingModel } from "@/lib/ai/models";

export type EmbeddableCardRow = {
  slug: string;
  canonical_name: string;
  subject: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  variant: string | null;
  market_price: number | null;
};

type ExistingHashRow = {
  canonical_slug: string;
  source_hash: string;
};

const EMBEDDING_BATCH_LIMIT = 100;

function resolveVercelPostgresConnectionString(): string | null {
  const direct =
    process.env.POSTGRES_URL?.trim()
    || process.env.POSTGRES_URL_NON_POOLING?.trim()
    || process.env.DATABASE_URL?.trim()
    || process.env.NEON_DATABASE_URL?.trim()
    || process.env.POPALPHA_POSTGRES_URL?.trim()
    || process.env.POPALPHA_POSTGRES_URL_NON_POOLING?.trim()
    || process.env.POPALPHA_DATABASE_URL?.trim()
    || process.env.POPALPHA_NEON_DATABASE_URL?.trim()
    || process.env.PopAlpha_POSTGRES_URL?.trim()
    || process.env.PopAlpha_POSTGRES_URL_NON_POOLING?.trim()
    || process.env.PopAlpha_DATABASE_URL?.trim()
    || process.env.PopAlpha_NEON_DATABASE_URL?.trim()
    || null;

  if (direct && !process.env.POSTGRES_URL) {
    process.env.POSTGRES_URL = direct;
  }

  return direct;
}

export function hasVercelPostgresConfig(): boolean {
  return resolveVercelPostgresConnectionString() !== null;
}

export function buildCardEmbeddingText(card: EmbeddableCardRow): string {
  return [
    `Card: ${card.canonical_name}`,
    card.subject ? `Subject: ${card.subject}` : null,
    card.set_name ? `Set: ${card.set_name}` : null,
    card.card_number ? `Card Number: ${card.card_number}` : null,
    card.year != null ? `Year: ${card.year}` : null,
    card.variant ? `Variant: ${card.variant}` : null,
    typeof card.market_price === "number" && Number.isFinite(card.market_price)
      ? `Current Market Price USD: ${card.market_price}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCardEmbeddingHash(card: EmbeddableCardRow): string {
  return crypto
    .createHash("sha256")
    .update(buildCardEmbeddingText(card))
    .digest("hex");
}

export async function ensureCardEmbeddingsSchema(): Promise<void> {
  if (!hasVercelPostgresConfig()) {
    throw new Error("Missing Vercel Postgres connection string. Set POSTGRES_URL or a compatible alternate env.");
  }

  await sql.query(`create extension if not exists vector;`);
  await sql.query(`
    create table if not exists card_embeddings (
      canonical_slug text primary key,
      canonical_name text not null,
      subject text null,
      set_name text null,
      year integer null,
      card_number text null,
      variant text null,
      market_price double precision null,
      embedding vector(3072) not null,
      source_hash text not null,
      updated_at timestamptz not null default now()
    );
  `);
  await sql.query(`
    drop index if exists card_embeddings_embedding_cosine_idx;
  `);
  await sql.query(`
    create index if not exists card_embeddings_set_name_idx
    on card_embeddings (set_name);
  `);
}

export async function fetchExistingEmbeddingHashes(
  slugs: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (slugs.length === 0) return out;

  const result = await sql.query<ExistingHashRow>(
    "select canonical_slug, source_hash from card_embeddings where canonical_slug = any($1::text[])",
    [slugs],
  );

  for (const row of result.rows) {
    out.set(row.canonical_slug, row.source_hash);
  }

  return out;
}

export async function refreshCardEmbeddingBatch(
  cards: EmbeddableCardRow[],
): Promise<{ processed: number; updated: number; skipped: number }> {
  if (cards.length === 0) {
    return { processed: 0, updated: 0, skipped: 0 };
  }

  await ensureCardEmbeddingsSchema();

  const existingHashes = await fetchExistingEmbeddingHashes(cards.map((card) => card.slug));
  const changedCards = cards.filter((card) => buildCardEmbeddingHash(card) !== existingHashes.get(card.slug));

  if (changedCards.length === 0) {
    return { processed: cards.length, updated: 0, skipped: cards.length };
  }

  const embeddingVectors: number[][] = [];
  for (let start = 0; start < changedCards.length; start += EMBEDDING_BATCH_LIMIT) {
    const chunk = changedCards.slice(start, start + EMBEDDING_BATCH_LIMIT);
    const chunkEmbeddings = await embedMany({
      model: getPopAlphaEmbeddingModel(),
      values: chunk.map(buildCardEmbeddingText),
    });
    embeddingVectors.push(...chunkEmbeddings.embeddings);
  }

  for (let index = 0; index < changedCards.length; index += 1) {
    const card = changedCards[index];
    const embedding = embeddingVectors[index];
    if (!card || !embedding) continue;

    const vectorLiteral = `[${embedding.join(",")}]`;
    const sourceHash = buildCardEmbeddingHash(card);

    await sql.query(
      `
        insert into card_embeddings (
          canonical_slug,
          canonical_name,
          subject,
          set_name,
          year,
          card_number,
          variant,
          market_price,
          embedding,
          source_hash,
          updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, now()
        )
        on conflict (canonical_slug) do update set
          canonical_name = excluded.canonical_name,
          subject = excluded.subject,
          set_name = excluded.set_name,
          year = excluded.year,
          card_number = excluded.card_number,
          variant = excluded.variant,
          market_price = excluded.market_price,
          embedding = excluded.embedding,
          source_hash = excluded.source_hash,
          updated_at = excluded.updated_at
      `,
      [
        card.slug,
        card.canonical_name,
        card.subject,
        card.set_name,
        card.year,
        card.card_number,
        card.variant,
        card.market_price,
        vectorLiteral,
        sourceHash,
      ],
    );
  }

  return {
    processed: cards.length,
    updated: changedCards.length,
    skipped: cards.length - changedCards.length,
  };
}
