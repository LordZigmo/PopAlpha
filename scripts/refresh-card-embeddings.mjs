import crypto from "node:crypto";
import { config as loadEnv } from "dotenv";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { embedMany } from "ai";
import { google } from "@ai-sdk/google";
import { sql } from "@vercel/postgres";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POSTGRES_CONNECTION_STRING =
  process.env.AI_NEON_DATABASE_URL
  || process.env.POPALPHA_NEON_DATABASE_URL
  || process.env.PopAlpha_NEON_DATABASE_URL
  || process.env.NEON_DATABASE_URL
  || process.env.POPALPHA_POSTGRES_URL
  || process.env.POPALPHA_POSTGRES_URL_NON_POOLING
  || process.env.PopAlpha_POSTGRES_URL
  || process.env.PopAlpha_POSTGRES_URL_NON_POOLING
  || process.env.POPALPHA_DATABASE_URL
  || process.env.PopAlpha_DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRES_URL_NON_POOLING
  || process.env.DATABASE_URL
  || null;

if (POSTGRES_CONNECTION_STRING && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = POSTGRES_CONNECTION_STRING;
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

if (!process.env.POSTGRES_URL) {
  throw new Error("Missing AI_NEON_DATABASE_URL (or POSTGRES_URL-compatible fallback) for AI embeddings storage.");
}

const maxCardsRaw = Number.parseInt(process.argv[2] ?? "512", 10);
const maxCards = Number.isFinite(maxCardsRaw) && maxCardsRaw > 0 ? maxCardsRaw : 512;
const fetchBatchSize = 128;
const embeddingBatchSize = 100;
const embeddingModel = google.textEmbeddingModel("gemini-embedding-001");

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function buildCardEmbeddingText(card) {
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

function buildCardEmbeddingHash(card) {
  return crypto
    .createHash("sha256")
    .update(buildCardEmbeddingText(card))
    .digest("hex");
}

async function ensureCardEmbeddingsSchema() {
  await sql.query("create extension if not exists vector;");
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

async function fetchExistingEmbeddingHashes(slugs) {
  if (slugs.length === 0) return new Map();
  const result = await sql.query(
    "select canonical_slug, source_hash from card_embeddings where canonical_slug = any($1::text[])",
    [slugs],
  );
  return new Map(result.rows.map((row) => [row.canonical_slug, row.source_hash]));
}

async function refreshCardEmbeddingBatch(cards) {
  if (cards.length === 0) {
    return { processed: 0, updated: 0, skipped: 0 };
  }

  await ensureCardEmbeddingsSchema();
  const existingHashes = await fetchExistingEmbeddingHashes(cards.map((card) => card.slug));
  const changedCards = cards.filter((card) => buildCardEmbeddingHash(card) !== existingHashes.get(card.slug));

  if (changedCards.length === 0) {
    return { processed: cards.length, updated: 0, skipped: cards.length };
  }

  const embeddingVectors = [];
  for (let start = 0; start < changedCards.length; start += embeddingBatchSize) {
    const chunk = changedCards.slice(start, start + embeddingBatchSize);
    const chunkEmbeddings = await embedMany({
      model: embeddingModel,
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

let processed = 0;
let updated = 0;
let skipped = 0;
let offset = 0;

while (processed < maxCards) {
  const upperBound = Math.min(offset + fetchBatchSize - 1, maxCards - 1);
  const { data: cards, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, set_name, year, card_number, variant")
    .order("slug", { ascending: true })
    .range(offset, upperBound);

  if (error) {
    throw new Error(error.message);
  }

  if (!cards || cards.length === 0) break;

  const slugs = cards.map((card) => card.slug);
  const { data: metricsRows, error: metricsError } = await supabase
    .from("public_card_metrics")
    .select("canonical_slug, market_price")
    .in("canonical_slug", slugs)
    .is("printing_id", null)
    .eq("grade", "RAW");

  if (metricsError) {
    throw new Error(metricsError.message);
  }

  const marketPriceBySlug = new Map();
  for (const row of metricsRows ?? []) {
    if (!marketPriceBySlug.has(row.canonical_slug)) {
      marketPriceBySlug.set(row.canonical_slug, row.market_price);
    }
  }

  const batchRows = cards.map((card) => ({
    ...card,
    market_price: marketPriceBySlug.get(card.slug) ?? null,
  }));

  const batchResult = await refreshCardEmbeddingBatch(batchRows);
  processed += batchResult.processed;
  updated += batchResult.updated;
  skipped += batchResult.skipped;

  if (cards.length < fetchBatchSize) break;
  offset += fetchBatchSize;
}

console.log(JSON.stringify({ ok: true, processed, updated, skipped, maxCards }));
