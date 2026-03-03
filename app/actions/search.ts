"use server";

import { embed } from "ai";
import { sql } from "@vercel/postgres";
import { hasVercelPostgresConfig } from "@/lib/ai/card-embeddings";
import { getPopAlphaEmbeddingModel } from "@/lib/ai/models";

export type SemanticSearchInput = {
  query: string;
  limit?: number;
};

export type SemanticSearchResult = {
  canonicalSlug: string;
  canonicalName: string;
  setName: string | null;
  year: number | null;
  marketPrice: number | null;
  similarity: number;
};

type SearchRow = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  market_price: number | null;
  similarity: number;
};

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  const rounded = Math.floor(limit ?? DEFAULT_LIMIT);
  return Math.max(1, Math.min(MAX_LIMIT, rounded));
}

function getVectorConfig() {
  return {
    table: process.env.POPALPHA_VECTOR_TABLE?.trim() || "card_embeddings",
    vectorColumn: process.env.POPALPHA_VECTOR_COLUMN?.trim() || "embedding",
    slugColumn: process.env.POPALPHA_VECTOR_SLUG_COLUMN?.trim() || "canonical_slug",
    nameColumn: process.env.POPALPHA_VECTOR_NAME_COLUMN?.trim() || "canonical_name",
    setColumn: process.env.POPALPHA_VECTOR_SET_COLUMN?.trim() || "set_name",
    yearColumn: process.env.POPALPHA_VECTOR_YEAR_COLUMN?.trim() || "year",
    priceColumn: process.env.POPALPHA_VECTOR_PRICE_COLUMN?.trim() || "market_price",
  };
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function toPgVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function normalizeQuery(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

export async function semanticSearchCards(
  input: SemanticSearchInput,
): Promise<SemanticSearchResult[]> {
  const query = normalizeQuery(input.query);
  if (!query) return [];
  if (!hasVercelPostgresConfig()) return [];

  const limit = clampLimit(input.limit);
  const config = getVectorConfig();
  const table = assertSafeIdentifier(config.table, "vector table");
  const vectorColumn = assertSafeIdentifier(config.vectorColumn, "vector column");
  const slugColumn = assertSafeIdentifier(config.slugColumn, "slug column");
  const nameColumn = assertSafeIdentifier(config.nameColumn, "name column");
  const setColumn = assertSafeIdentifier(config.setColumn, "set column");
  const yearColumn = assertSafeIdentifier(config.yearColumn, "year column");
  const priceColumn = assertSafeIdentifier(config.priceColumn, "price column");

  const embeddingResult = await embed({
    model: getPopAlphaEmbeddingModel(),
    value: query,
  });

  const vectorLiteral = toPgVectorLiteral(embeddingResult.embedding);
  const queryText = `
    select
      ${slugColumn} as canonical_slug,
      ${nameColumn} as canonical_name,
      ${setColumn} as set_name,
      ${yearColumn} as year,
      ${priceColumn} as market_price,
      greatest(0, 1 - (${vectorColumn} <=> $1::vector)) as similarity
    from ${table}
    where ${vectorColumn} is not null
    order by ${vectorColumn} <=> $1::vector
    limit $2
  `;

  const result = await sql.query<SearchRow>(queryText, [vectorLiteral, limit]);

  return result.rows.map((row) => ({
    canonicalSlug: row.canonical_slug,
    canonicalName: row.canonical_name,
    setName: row.set_name,
    year: typeof row.year === "number" && Number.isFinite(row.year) ? row.year : null,
    marketPrice:
      typeof row.market_price === "number" && Number.isFinite(row.market_price)
        ? row.market_price
        : null,
    similarity: Number(row.similarity),
  }));
}
