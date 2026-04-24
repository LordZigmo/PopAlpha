/**
 * One-shot cron: backfill card_image_embeddings.is_digital_only
 *
 * Cross-DB: reads the set of digital-only slugs from Supabase
 * (canonical_cards.primary_image_url LIKE '%/pokemon/tcgp-%') and
 * bulk-UPDATEs Neon's card_image_embeddings to flip is_digital_only
 * from false → true for those slugs. Idempotent — re-runs are a no-op
 * once every digital row is flagged.
 *
 * Same logic as scripts/backfill-card-image-digital-flag.mjs, but
 * runs server-side so it uses Vercel's production Neon URL instead
 * of whatever POSTGRES_URL the operator has in .env.local. Designed
 * to be invoked once manually via curl after the is_digital_only
 * column + filter land in prod; not on the */X scheduled list.
 */

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { hasVercelPostgresConfig, ensureCardImageEmbeddingsSchema } from "@/lib/ai/card-image-embeddings";

export const runtime = "nodejs";
export const maxDuration = 60;

const SUPABASE_PAGE_SIZE = 1000;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  if (!hasVercelPostgresConfig()) {
    return NextResponse.json(
      { ok: false, error: "Missing Vercel Postgres connection string." },
      { status: 500 },
    );
  }

  // Ensure is_digital_only column exists before we try to UPDATE it.
  await ensureCardImageEmbeddingsSchema();

  const supabase = dbAdmin();

  // Collect digital-only slugs in pages. Catalog has ~2.4k tcgp rows
  // out of ~23k total so a few round-trips.
  const digitalSlugs: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug")
      .like("primary_image_url", "%/pokemon/tcgp-%")
      .range(offset, offset + SUPABASE_PAGE_SIZE - 1);

    if (error) {
      return NextResponse.json(
        { ok: false, error: `supabase select: ${error.message}` },
        { status: 500 },
      );
    }

    const rows = (data ?? []) as Array<{ slug: string }>;
    for (const row of rows) digitalSlugs.push(row.slug);
    if (rows.length < SUPABASE_PAGE_SIZE) break;
    offset += SUPABASE_PAGE_SIZE;
  }

  if (digitalSlugs.length === 0) {
    return NextResponse.json({
      ok: true,
      digital_slugs_found: 0,
      rows_updated: 0,
      note: "No digital-only slugs found in canonical_cards; nothing to backfill.",
    });
  }

  // Bulk update Neon. Single query, array param — Neon's pg driver
  // handles ~2.5k elements cleanly.
  const result = await sql.query(
    `
      update card_image_embeddings
      set is_digital_only = true,
          updated_at = now()
      where canonical_slug = any($1::text[])
        and is_digital_only = false
    `,
    [digitalSlugs],
  );

  // Sanity: total digital-flagged rows after the update.
  const after = await sql.query<{ n: number }>(
    `select count(*)::int as n from card_image_embeddings where is_digital_only = true`,
  );

  return NextResponse.json({
    ok: true,
    digital_slugs_found: digitalSlugs.length,
    rows_updated: result.rowCount ?? 0,
    total_digital_flagged_after: after.rows[0]?.n ?? 0,
  });
}
