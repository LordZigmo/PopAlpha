/**
 * GET /api/catalog/anchors-since
 *
 * Anchor delta sync for the offline scanner. Returns user_correction
 * rows added (or updated) since a watermark. The iOS app pulls this
 * on app launch + after every successful correction so the offline
 * .papb catalog can effectively grow new entries without rebuilding
 * the whole bundle.
 *
 * The static .papb is a snapshot. Without this delta endpoint, every
 * correction the user makes via the picker lands server-side but
 * never reaches their offline catalog → corrections feel useless.
 * That's the bug the user reported on 2026-05-02 with Premium Power
 * Pro: corrected twice via the picker, third scan still wrong.
 *
 * Trust model: PUBLIC read. The base catalog (.papb) at
 * `card-images/catalog-bundles/v1/siglip2_catalog_v1.papb` is also
 * served publicly — anchors are derived from the same data
 * (canonical_cards) plus user-correction frames whose embeddings
 * are non-PII. Future hardening: signed URLs scoped to premium
 * entitlement.
 *
 * Query params:
 *   - model_version (required): the iOS app's currently-loaded
 *     catalog model_version. Server filters anchors to the same
 *     model so iOS only ever merges vectors from the same embedding
 *     space. e.g. "siglip2-base-patch16-384-v1".
 *   - since (optional): ISO-8601 timestamp. When provided, only
 *     anchors with updated_at > since are returned. When absent,
 *     the full anchor set for the model is returned.
 *   - limit (optional): cap row count (default 500, hard max 5000).
 *     The catalog has 28 anchors today; we don't expect to hit limits
 *     in the near term, but a cap protects the iOS app from a
 *     pathological catalog poisoning attempt.
 *
 * Response:
 *   {
 *     ok: true,
 *     server_now: "2026-05-02T20:00:00Z",
 *     model_version: "...",
 *     anchor_count: 14,
 *     anchors: [
 *       {
 *         canonical_slug, set_name, card_number, language,
 *         variant_index,        // u32; user_corrections are >= 10000
 *         updated_at,           // ISO so iOS can advance the watermark
 *         embedding             // [768 fp32 numbers]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Cost: each anchor's embedding is ~6KB JSON (768 fp32 floats × ~8
 * char average). For 14 anchors: ~84KB. For 1000 anchors: ~6MB. If we
 * outgrow that we'd switch to a binary delta format (precedent: the
 * .papb itself); v1 JSON is fine.
 */

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const VALID_MODEL_VERSION_RE = /^[a-zA-Z0-9._-]{1,128}$/;

type AnchorRow = {
  canonical_slug: string;
  set_name: string | null;
  card_number: string | null;
  language: string | null;
  variant_index: number;
  updated_at: string;
  embedding: string;
};

function parseEmbedding(text: string): number[] | null {
  // pgvector text representation: "[0.1,-0.2,...]" — strip brackets +
  // split on commas. Per-element parseFloat catches inf/NaN.
  if (typeof text !== "string" || text.length < 3) return null;
  const inner = text.startsWith("[") && text.endsWith("]")
    ? text.slice(1, -1)
    : text;
  const parts = inner.split(",");
  if (parts.length !== 768) return null;
  const out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const modelVersionRaw = url.searchParams.get("model_version") ?? "";
  const sinceRaw = url.searchParams.get("since");
  const limitRaw = url.searchParams.get("limit");

  if (!VALID_MODEL_VERSION_RE.test(modelVersionRaw)) {
    return NextResponse.json(
      { ok: false, error: "model_version is required and must match /^[a-zA-Z0-9._-]{1,128}$/" },
      { status: 400 },
    );
  }
  const modelVersion = modelVersionRaw;

  let since: Date | null = null;
  if (sinceRaw) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { ok: false, error: "since must be a valid ISO-8601 timestamp" },
        { status: 400 },
      );
    }
    since = parsed;
  }

  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const parsedLimit = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      limit = Math.min(parsedLimit, MAX_LIMIT);
    }
  }

  // Pull rows. crop_type='full' matches the .papb format which only
  // carries full-card embeddings (the offline catalog never sees art
  // crops). source='user_correction' is the population we want.
  const rows = since
    ? await sql.query<AnchorRow>(
        `select
           canonical_slug,
           set_name,
           card_number,
           language,
           variant_index,
           updated_at,
           embedding::text as embedding
         from card_image_embeddings
         where source = 'user_correction'
           and crop_type = 'full'
           and model_version = $1
           and updated_at > $2
         order by updated_at asc, canonical_slug asc, variant_index asc
         limit $3`,
        [modelVersion, since.toISOString(), limit],
      )
    : await sql.query<AnchorRow>(
        `select
           canonical_slug,
           set_name,
           card_number,
           language,
           variant_index,
           updated_at,
           embedding::text as embedding
         from card_image_embeddings
         where source = 'user_correction'
           and crop_type = 'full'
           and model_version = $1
         order by updated_at asc, canonical_slug asc, variant_index asc
         limit $2`,
        [modelVersion, limit],
      );

  const anchors = [] as Array<{
    canonical_slug: string;
    set_name: string | null;
    card_number: string | null;
    language: string | null;
    variant_index: number;
    updated_at: string;
    embedding: number[];
  }>;
  let droppedCount = 0;
  for (const row of rows.rows) {
    const vec = parseEmbedding(row.embedding);
    if (!vec) {
      droppedCount += 1;
      continue;
    }
    anchors.push({
      canonical_slug: row.canonical_slug,
      set_name: row.set_name,
      card_number: row.card_number,
      language: row.language,
      variant_index: row.variant_index,
      updated_at: row.updated_at,
      embedding: vec,
    });
  }

  if (droppedCount > 0) {
    console.warn(
      `[anchors-since] dropped ${droppedCount} rows with malformed embeddings (model=${modelVersion})`,
    );
  }

  return NextResponse.json({
    ok: true,
    server_now: new Date().toISOString(),
    model_version: modelVersion,
    anchor_count: anchors.length,
    anchors,
  });
}
