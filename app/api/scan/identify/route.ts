/**
 * POST /api/scan/identify
 *
 * Identifies a single Pokemon card from a just-captured image. Used by
 * the iOS scanner's zero-tap recognition flow: client POSTs the JPEG
 * it captured when its Vision rectangle detector stabilized on a card,
 * server embeds it with the same CLIP model used to build the
 * reference index, runs a language-filtered pgvector kNN, and returns
 * the top matches with a confidence tier.
 *
 * Trust tier: PUBLIC. The app is freemium; scanning is a core funnel.
 * No rate limit in this PR — call-volume telemetry will inform whether
 * we need one later.
 *
 * Request:
 *   POST /api/scan/identify?language=EN&limit=5
 *   Content-Type: image/jpeg
 *   body: <jpeg bytes, max ~2MB>
 *
 * Response (200):
 *   {
 *     ok: true,
 *     confidence: "high" | "medium" | "low",
 *     matches: [{ slug, canonical_name, language, set_name,
 *                 card_number, variant, mirrored_primary_image_url,
 *                 similarity }],
 *     language_filter: "EN" | "JP",
 *     model_version: string,
 *   }
 *
 * Response (5xx): { ok: false, error: string }
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { hasVercelPostgresConfig } from "@/lib/ai/card-embeddings";
import { dbAdmin } from "@/lib/db/admin";
import {
  getReplicateClipEmbedder,
  hasReplicateConfig,
  ImageEmbedderConfigError,
  ImageEmbedderRuntimeError,
} from "@/lib/ai/image-embedder";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/**
 * Confidence tiers derived empirically from the reference-catalog
 * kNN behavior we validated at ~2,500 rows (see the Charizard probe):
 *
 *   cos_dist ≤ 0.02  → essentially the same card (high)
 *   cos_dist ≤ 0.08  → same character / very similar art (medium —
 *                     variant ambiguity, needs OCR secondary signal)
 *   cos_dist > 0.08  → probably wrong card (low)
 *
 * iOS treats "high" as the zero-tap auto-navigate signal. "Medium"
 * surfaces matches for user confirmation. "Low" is ignored and the
 * scanner keeps hunting.
 */
const CONFIDENCE_HIGH_COS_DIST = 0.02;
const CONFIDENCE_MEDIUM_COS_DIST = 0.08;

type MatchRow = {
  canonical_slug: string;
  canonical_name: string;
  language: string | null;
  set_name: string | null;
  card_number: string | null;
  variant: string | null;
  source_image_url: string | null;
  cos_dist: number;
};

function parseLanguage(raw: string | null): "EN" | "JP" {
  const normalized = raw?.trim().toUpperCase();
  return normalized === "JP" ? "JP" : "EN";
}

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function classifyConfidence(topDistance: number | undefined): "high" | "medium" | "low" {
  if (topDistance === undefined) return "low";
  if (topDistance <= CONFIDENCE_HIGH_COS_DIST) return "high";
  if (topDistance <= CONFIDENCE_MEDIUM_COS_DIST) return "medium";
  return "low";
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const actorKey = req.headers.get("x-pa-actor-key");
  const clientPlatform = req.headers.get("x-pa-client-platform");

  if (!hasVercelPostgresConfig()) {
    return NextResponse.json(
      { ok: false, error: "Image embeddings database is not configured." },
      { status: 503 },
    );
  }

  if (!hasReplicateConfig()) {
    return NextResponse.json(
      { ok: false, error: "Embedder is not configured." },
      { status: 503 },
    );
  }

  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
    return NextResponse.json(
      { ok: false, error: "Request must carry an image/* or application/octet-stream body." },
      { status: 415 },
    );
  }

  const mimeType = contentType.startsWith("image/") ? contentType.split(";")[0] : "image/jpeg";

  let bytes: Buffer;
  try {
    const arrayBuffer = await req.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      return NextResponse.json(
        { ok: false, error: "Empty request body." },
        { status: 400 },
      );
    }
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { ok: false, error: `Image exceeds ${MAX_IMAGE_BYTES} byte limit.` },
        { status: 413 },
      );
    }
    bytes = Buffer.from(arrayBuffer);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to read request body." },
      { status: 400 },
    );
  }

  const imageHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const imageBytesSize = bytes.length;

  const { searchParams } = new URL(req.url);
  const language = parseLanguage(searchParams.get("language"));
  const limit = parseLimit(searchParams.get("limit"));

  let embedder;
  try {
    embedder = getReplicateClipEmbedder();
  } catch (err) {
    if (err instanceof ImageEmbedderConfigError) {
      await logScanEvent({
        imageHash,
        imageBytesSize,
        language,
        confidence: "error",
        modelVersion: "unknown",
        durationMs: Date.now() - startedAt,
        error: err.message,
        actorKey,
        clientPlatform,
      });
      return NextResponse.json({ ok: false, error: err.message }, { status: 503 });
    }
    throw err;
  }

  // Stash the scan in Supabase Storage and pass a public URL to
  // Replicate. The andreasjansson/clip-features model parses line-
  // delimited inputs as URLs-or-text; it happily embeds a data-URL
  // string as TEXT (not as the decoded image), which produced the
  // ~0.19 similarity floor we hit on first device testing. Matching
  // the catalog ingestion path — which always embeds via public URL —
  // gets the two indexes into the same embedding space.
  //
  // Keyed by imageHash so identical scans are idempotent uploads.
  // bucket lifecycle cleanup for scan-uploads/* is a follow-up.
  const supabase = dbAdmin();
  const scanKey = `scan-uploads/${imageHash}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from("card-images")
    .upload(scanKey, bytes, {
      upsert: true,
      contentType: "image/jpeg",
      cacheControl: "no-cache",
    });

  if (uploadError) {
    await logScanEvent({
      imageHash,
      imageBytesSize,
      language,
      confidence: "error",
      modelVersion: embedder.modelVersion,
      durationMs: Date.now() - startedAt,
      error: `Storage upload failed: ${uploadError.message}`.slice(0, 500),
      actorKey,
      clientPlatform,
    });
    return NextResponse.json(
      { ok: false, error: `Storage upload failed: ${uploadError.message}` },
      { status: 502 },
    );
  }

  const scanPublicUrl = supabase.storage
    .from("card-images")
    .getPublicUrl(scanKey).data.publicUrl;

  let queryEmbedding: number[];
  try {
    const results = await embedder.embedUrls([scanPublicUrl]);
    const first = results[0];
    if (!first || first.embedding === null) {
      const message = first?.error ?? "embedder returned no result";
      await logScanEvent({
        imageHash,
        imageBytesSize,
        language,
        confidence: "error",
        modelVersion: embedder.modelVersion,
        durationMs: Date.now() - startedAt,
        error: `Embedder failure: ${message}`.slice(0, 500),
        actorKey,
        clientPlatform,
      });
      return NextResponse.json(
        { ok: false, error: `Embedder failure: ${message}` },
        { status: 502 },
      );
    }
    queryEmbedding = first.embedding;
  } catch (err) {
    if (err instanceof ImageEmbedderRuntimeError) {
      await logScanEvent({
        imageHash,
        imageBytesSize,
        language,
        confidence: "error",
        modelVersion: embedder.modelVersion,
        durationMs: Date.now() - startedAt,
        error: `Embedder failure: ${err.message}`.slice(0, 500),
        actorKey,
        clientPlatform,
      });
      return NextResponse.json(
        { ok: false, error: `Embedder failure: ${err.message}` },
        { status: 502 },
      );
    }
    throw err;
  }

  if (queryEmbedding.length !== embedder.dimensions) {
    const message = `Embedder returned unexpected dimensions: ${queryEmbedding.length} vs ${embedder.dimensions}`;
    await logScanEvent({
      imageHash,
      imageBytesSize,
      language,
      confidence: "error",
      modelVersion: embedder.modelVersion,
      durationMs: Date.now() - startedAt,
      error: message,
      actorKey,
      clientPlatform,
    });
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  let matches: MatchRow[];
  try {
    const result = await sql.query<MatchRow>(
      `
        select
          canonical_slug,
          canonical_name,
          language,
          set_name,
          card_number,
          variant,
          source_image_url,
          (embedding <=> $1::vector) as cos_dist
        from card_image_embeddings
        where model_version = $2
          and language = $3
        order by embedding <=> $1::vector
        limit $4
      `,
      [vectorLiteral, embedder.modelVersion, language, limit],
    );
    matches = result.rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : "pgvector query failed";
    await logScanEvent({
      imageHash,
      imageBytesSize,
      language,
      confidence: "error",
      modelVersion: embedder.modelVersion,
      durationMs: Date.now() - startedAt,
      error: message.slice(0, 500),
      actorKey,
      clientPlatform,
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  const topDistance = matches[0]?.cos_dist;
  const confidence = classifyConfidence(topDistance);
  const topSimilarity = matches[0] ? 1 - matches[0].cos_dist : null;
  const rank2 = matches[1];
  const rank2Similarity = rank2 ? 1 - rank2.cos_dist : null;
  const topGap =
    topSimilarity !== null && rank2Similarity !== null
      ? topSimilarity - rank2Similarity
      : null;

  await logScanEvent({
    imageHash,
    imageBytesSize,
    language,
    confidence,
    topMatchSlug: matches[0]?.canonical_slug ?? null,
    topSimilarity,
    topGapToRank2: topGap,
    rank2Slug: rank2?.canonical_slug ?? null,
    rank2Similarity,
    modelVersion: embedder.modelVersion,
    durationMs: Date.now() - startedAt,
    actorKey,
    clientPlatform,
  });

  return NextResponse.json({
    ok: true,
    confidence,
    matches: matches.map((row) => ({
      slug: row.canonical_slug,
      canonical_name: row.canonical_name,
      language: row.language,
      set_name: row.set_name,
      card_number: row.card_number,
      variant: row.variant,
      mirrored_primary_image_url: row.source_image_url,
      similarity: Number.isFinite(row.cos_dist) ? 1 - row.cos_dist : 0,
    })),
    language_filter: language,
    model_version: embedder.modelVersion,
  });
}

// MARK: - Telemetry
//
// Best-effort append-only logger. Never throws out of this function —
// a telemetry failure must not fail the scan. Logs to console so ops
// can correlate; the scan identify response is unaffected.

type ScanEventInput = {
  imageHash: string;
  imageBytesSize: number;
  language: "EN" | "JP";
  confidence: "high" | "medium" | "low" | "error";
  topMatchSlug?: string | null;
  topSimilarity?: number | null;
  topGapToRank2?: number | null;
  rank2Slug?: string | null;
  rank2Similarity?: number | null;
  modelVersion: string;
  durationMs: number;
  error?: string | null;
  actorKey?: string | null;
  clientPlatform?: string | null;
};

async function logScanEvent(event: ScanEventInput): Promise<void> {
  try {
    const { error } = await dbAdmin()
      .from("scan_identify_events")
      .insert({
        image_hash: event.imageHash,
        image_bytes_size: event.imageBytesSize,
        language_filter: event.language,
        confidence: event.confidence,
        top_match_slug: event.topMatchSlug ?? null,
        top_similarity: event.topSimilarity ?? null,
        top_gap_to_rank_2: event.topGapToRank2 ?? null,
        rank_2_slug: event.rank2Slug ?? null,
        rank_2_similarity: event.rank2Similarity ?? null,
        model_version: event.modelVersion,
        duration_ms: event.durationMs,
        error: event.error ?? null,
        actor_key: event.actorKey ?? null,
        client_platform: event.clientPlatform ?? null,
      });

    if (error) {
      console.warn(`[scan/identify] telemetry insert failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(
      `[scan/identify] telemetry unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
