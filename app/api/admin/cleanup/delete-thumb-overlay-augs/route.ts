/**
 * One-shot cleanup: DELETE recipe-v2 synthetic-thumb-overlay rows from
 * Neon's card_image_embeddings table. These are variant_index 3 and 4
 * (recipeId v2-thumb-bottom-right and v2-thumb-top-left) that were
 * retired 2026-04-29 after the operator caught them acting as
 * skin-tone magnets in production scans — see the post-mortem in
 * lib/ai/image-augmentations.ts header.
 *
 * Why an API route rather than a local script: .env.local has empty
 * POSTGRES_URL on the operator's machine; Vercel runtime has the real
 * Neon connection string baked in via project env. Same shape as the
 * earlier admin/cleanup/dedupe-canonical-slugs-neon (since deleted)
 * — we accept the slight ergonomic friction of curl+CRON_SECRET to
 * avoid setting up direct Neon access locally.
 *
 * Trust: cron — Authorization: Bearer CRON_SECRET. requireCron also
 * accepts ADMIN_SECRET, so either works. Classified as cron-trust in
 * the registry even though the path lives under admin/cleanup (path
 * describes intent, registry classifies trust model).
 *
 * Idempotent: re-running after a successful cleanup returns
 * rows_deleted=0 and skips the storage cleanup advice. Safe to leave
 * deployed and replay if needed.
 *
 * Companion: scripts/delete-thumb-overlay-storage.mjs cleans the
 * matching `augmented/<slug>/v3-*.jpg` and `v4-*.jpg` Storage objects.
 * That runs locally because Storage operations are fast over HTTPS
 * and don't need Vercel-side env injection.
 *
 * Removable after the cleanup ships and verifies. Disposable one-shot.
 */

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { requireCron } from "@/lib/auth/require";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();

  // Pre-flight: how many rows match? Helps confirm we're targeting the
  // right thing and gives us a verifiable before-count.
  const before = await sql.query<{ rows: number }>(
    `SELECT COUNT(*)::int AS rows
       FROM card_image_embeddings
      WHERE variant_index IN (3, 4)`,
  );
  const rowsBefore = before.rows[0]?.rows ?? 0;

  if (rowsBefore === 0) {
    return NextResponse.json({
      ok: true,
      job: "delete_thumb_overlay_augs",
      message: "No variant_index IN (3, 4) rows in Neon — nothing to clean.",
      rows_before: 0,
      rows_deleted: 0,
      rows_after: 0,
      durationMs: Date.now() - startedAt,
    });
  }

  // Per-recipeId breakdown for audit visibility.
  const breakdown = await sql.query<{ variant_index: number; n: number }>(
    `SELECT variant_index, COUNT(*)::int AS n
       FROM card_image_embeddings
      WHERE variant_index IN (3, 4)
      GROUP BY variant_index
      ORDER BY variant_index`,
  );

  const deleted = await sql.query(
    `DELETE FROM card_image_embeddings
      WHERE variant_index IN (3, 4)`,
  );

  const after = await sql.query<{ rows: number }>(
    `SELECT COUNT(*)::int AS rows
       FROM card_image_embeddings
      WHERE variant_index IN (3, 4)`,
  );
  const rowsAfter = after.rows[0]?.rows ?? 0;

  return NextResponse.json({
    ok: rowsAfter === 0,
    job: "delete_thumb_overlay_augs",
    rows_before: rowsBefore,
    rows_deleted: deleted.rowCount ?? 0,
    rows_after: rowsAfter,
    breakdown: breakdown.rows,
    next_step: rowsAfter === 0
      ? "Run `npm run scan-eval:delete-thumb-overlay-storage` to delete the matching Storage objects."
      : "rows_after > 0 — investigate before proceeding.",
    durationMs: Date.now() - startedAt,
  });
}
