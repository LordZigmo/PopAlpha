/**
 * Cron: refresh-card-embeddings
 *
 * Syncs canonical card embeddings from Supabase into Vercel Postgres pgvector.
 * Safe to re-run: rows are skipped when the embedding source hash is unchanged.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  hasVercelPostgresConfig,
  refreshCardEmbeddingBatch,
  type EmbeddableCardRow,
} from "@/lib/ai/card-embeddings";

export const runtime = "nodejs";
export const maxDuration = 300;

const FETCH_BATCH_SIZE = 128;
const DEFAULT_MAX_CARDS = 512;
const MAX_CARDS_LIMIT = 2048;

function parseMaxCards(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CARDS;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const maxCards = parseMaxCards(searchParams.get("maxCards"));
  if (!hasVercelPostgresConfig()) {
    return NextResponse.json(
      { ok: false, error: "Missing Vercel Postgres connection string. Set POSTGRES_URL." },
      { status: 500 },
    );
  }

  const supabase = dbAdmin();
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let offset = 0;

  while (processed < maxCards) {
    const upperBound = Math.min(offset + FETCH_BATCH_SIZE - 1, maxCards - 1);
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, subject, set_name, year, card_number, variant")
      .order("slug", { ascending: true })
      .range(offset, upperBound);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const cards = (data ?? []) as Array<{
      slug: string;
      canonical_name: string;
      subject: string | null;
      set_name: string | null;
      year: number | null;
      card_number: string | null;
      variant: string | null;
    }>;

    if (cards.length === 0) break;

    const slugs = cards.map((card) => card.slug);
    const { data: metricsRows, error: metricsError } = await supabase
      .from("public_card_metrics")
      .select("canonical_slug, market_price")
      .in("canonical_slug", slugs)
      .is("printing_id", null)
      .eq("grade", "RAW");

    if (metricsError) {
      return NextResponse.json({ ok: false, error: metricsError.message }, { status: 500 });
    }

    const marketPriceBySlug = new Map<string, number | null>();
    for (const row of (metricsRows ?? []) as Array<{ canonical_slug: string; market_price: number | null }>) {
      if (!marketPriceBySlug.has(row.canonical_slug)) {
        marketPriceBySlug.set(row.canonical_slug, row.market_price);
      }
    }

    const batchRows: EmbeddableCardRow[] = cards.map((card) => ({
      ...card,
      market_price: marketPriceBySlug.get(card.slug) ?? null,
    }));

    const batchResult = await refreshCardEmbeddingBatch(batchRows);
    processed += batchResult.processed;
    updated += batchResult.updated;
    skipped += batchResult.skipped;

    if (cards.length < FETCH_BATCH_SIZE) break;
    offset += FETCH_BATCH_SIZE;
  }

  return NextResponse.json({
    ok: true,
    processed,
    updated,
    skipped,
    maxCards,
  });
}
