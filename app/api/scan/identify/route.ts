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
import {
  applyCropTransform,
  ImageCropError,
  resizeForUpload,
} from "@/lib/ai/image-crops";
import { getPostHogClient } from "@/lib/posthog-server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/**
 * Confidence tiers calibrated from baseline-eval data (run id
 * 8adb3eaa-a805-4d0b-81d7-cd9185ce1fcb, 157 user-photos, 2026-04-28).
 *
 * The first round of thresholds (≤0.02 high, ≤0.08 medium) was tuned
 * from a kNN self-test where the query was a reference embedding —
 * so any "correct" match was effectively cos_dist = 0. Real camera
 * captures of the same card land around cos_dist 0.20-0.25 even when
 * correctly identified, because the embedding picks up lighting /
 * angle / JPEG-compression / sensor differences between the Scrydex
 * product shot and the user's phone capture.
 *
 * The 2nd round (≤0.30 high / ≤0.45 medium / 0.005 gap) was over-
 * generous: 23% of "high" calls were wrong (26/113), and the medium
 * tier had 5% precision — essentially noise being shown as a guess.
 *
 * Per baseline-eval distribution, GAP is the dominant signal:
 *
 *   cos_dist ≤ 0.25 AND gap ≥ 0.04  → 59/59 = 100% precision  → high
 *   cos_dist ≤ 0.30                  → 22/52 = 42% precision  → medium
 *                                                              (still useful — top-5 lets user pick)
 *   cos_dist >  0.30                 → 8/43  = 19% precision  → low
 *                                                              (suppress; keep scanning)
 *
 * HIGH = "auto-navigate, zero-tap." Tightening cos_dist to 0.25 plus
 * raising the gap floor to 0.04 collapses the high-conf-wrong rate
 * from 23% to ~0% on the baseline eval. We trade fewer auto-navs for
 * a precision bar that won't burn user trust.
 *
 * MEDIUM = "show top-5, user picks." The 0.30 cap keeps medium honest:
 * everything below is still close enough to the right card that the
 * top-5 list contains the answer often enough to be worth showing.
 *
 * LOW = "don't show; keep scanning." Below 0.30, surfacing the guess
 * was actively misleading (19% precision) — better to ask for another
 * frame.
 */
const CONFIDENCE_HIGH_COS_DIST = 0.25;
const CONFIDENCE_MEDIUM_COS_DIST = 0.30;
const CONFIDENCE_HIGH_MIN_GAP = 0.04;

/**
 * Per-crop-type kNN. Run once per crop_type (full and art) at query
 * time; results are merged max-by-slug in the route handler.
 *
 *   $1 — query embedding vector literal
 *   $2 — model_version (must match what the index was built with)
 *   $3 — language filter (EN | JP)
 *   $4 — top-K limit
 *   $5 — crop_type ('full' | 'art')
 *
 * Per-slug dedup via DISTINCT ON: a given canonical_slug can have
 * multiple variant rows in the index (Stage C augmentations under
 * crop_type='full'). DISTINCT ON returns the closest variant per slug.
 * The 4× overfetch in the inner CTE keeps dedup from starving the
 * final top-K when many top-N raw hits cluster on a few slugs.
 *
 * is_digital_only = false excludes TCG Pocket cards (Pokemon's mobile-
 * game-only catalog). Those polluted early eval results before the
 * filter landed (Cramorant→Pidgey, Lopunny→Lucario) by clustering
 * compositionally with physical-card art in CLIP space.
 *
 * Recipe v2 thumb-overlay variants (variant_index 3, 4) were retired
 * 2026-04-29 — see lib/ai/image-augmentations.ts header. Their
 * 2,298 rows were physically deleted from this index and we stopped
 * generating new ones. No runtime filter needed; the data is gone.
 */
const KNN_QUERY = `
  with nearest_variants as (
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
      and is_digital_only = false
      and crop_type = $5
    order by embedding <=> $1::vector
    limit $4 * 4
  ),
  dedup as (
    select distinct on (canonical_slug)
      canonical_slug,
      canonical_name,
      language,
      set_name,
      card_number,
      variant,
      source_image_url,
      cos_dist
    from nearest_variants
    order by canonical_slug, cos_dist
  )
  select *
  from dedup
  order by cos_dist
  limit $4
`;

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

/**
 * MatchRow tagged with which crop branch (full / art) produced it.
 * Used by the merge step + by the Day 2 direct-lookup path which
 * needs to materialize a match without going through the kNN.
 */
type MatchWithCrop = MatchRow & { winning_crop: "full" | "art" };

/**
 * Day 2 two-stage retrieval path. Logged to scan_identify_events and
 * surfaced in the response so iOS / production dashboards can see
 * which signal resolved each scan.
 *
 *   vision_only            — Path C fallback. CLIP kNN top-K with the
 *                             optional card_number / set_hint
 *                             post-filters from Day 1 (b76faed +
 *                             8f11595).
 *   ocr_direct_unique      — Path A unique. iOS sent BOTH card_number
 *                             AND set_hint; SELECT canonical_cards
 *                             with both filters returned exactly 1
 *                             row → HIGH confidence regardless of
 *                             CLIP signal.
 *   ocr_direct_narrow      — Path A narrow. Same direct query
 *                             returned 2-3 rows; intersected with
 *                             kNN ordering and returned the highest-
 *                             similarity survivor at MEDIUM.
 *   ocr_intersect_unique   — Path B unique. iOS sent card_number
 *                             only (set_hint absent or noisy).
 *                             SELECT canonical_cards by card_number
 *                             returned N rows; intersected with kNN
 *                             top-K and exactly one slug survived →
 *                             HIGH (dual-signal: OCR + CLIP agree).
 *   ocr_intersect_narrow   — Path B narrow. 2-3 survivors in the
 *                             intersection → MEDIUM.
 */
type WinningPath =
  | "vision_only"
  | "ocr_direct_unique"
  | "ocr_direct_narrow"
  | "ocr_intersect_unique"
  | "ocr_intersect_narrow";

/**
 * Row shape returned by the OCR-direct canonical_cards query. Carries
 * the metadata needed to build a ScanMatch response without a kNN
 * round-trip.
 */
type CanonicalRow = {
  slug: string;
  canonical_name: string;
  language: string | null;
  set_name: string | null;
  card_number: string | null;
  variant: string | null;
  mirrored_primary_image_url: string | null;
};

/**
 * Adapt a CanonicalRow into the MatchWithCrop shape the response
 * builder expects. cos_dist is unknown when the slug came from a
 * direct lookup that didn't appear in kNN top-K — we synthesize a
 * sentinel value so similarity reports as `1 - 0 = 1.0`. Iterations
 * could compute a real similarity by querying card_image_embeddings
 * for this slug and dotting against the query embedding, but for
 * the first version a sentinel is honest enough — the caller
 * already knows path === "ocr_direct_unique" means the answer
 * came from OCR + DB, not CLIP.
 */
function canonicalRowToMatch(row: CanonicalRow, cosDist: number): MatchWithCrop {
  return {
    canonical_slug: row.slug,
    canonical_name: row.canonical_name,
    language: row.language,
    set_name: row.set_name,
    card_number: row.card_number,
    variant: row.variant,
    source_image_url: row.mirrored_primary_image_url,
    cos_dist: cosDist,
    winning_crop: "full",
  };
}

// Closed enum so adding a new failure mode requires updating this
// type, which forces a corresponding PostHog dashboard / alert update.
type FailureReason =
  | "config_missing"
  | "replicate_unavailable"
  | "bad_content_type"
  | "body_empty"
  | "body_too_large"
  | "body_read_failed"
  | "embedder_config"
  | "storage_upload_failed"
  | "embedder_returned_null"
  | "embedder_runtime_error"
  | "embedding_dimension_mismatch"
  | "pgvector_query_failed";

function parseLanguage(raw: string | null): "EN" | "JP" {
  const normalized = raw?.trim().toUpperCase();
  return normalized === "JP" ? "JP" : "EN";
}

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Normalize a printed collector number into the shape canonical_cards
 * stores. Accepts any of:
 *   "70"          → "70"
 *   "70/197"      → "70"
 *   " #70/197 "   → "70"
 *   "TG04"        → "TG04"      (alphanumeric — keep as-is)
 *   "SWSH062"     → "SWSH062"
 *   "044/030"     → "044"
 * Returns null for empty/whitespace input.
 *
 * For pure-digit values we strip leading zeros to match the eval-set
 * canonical_cards.card_number convention (e.g. "070" → "70"); for
 * alphanumeric codes we preserve them verbatim because their leading
 * letters carry the set/series prefix.
 */
function parseCardNumberFilter(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const slashMatch = trimmed.match(/^#?\s*([A-Za-z0-9]+)\s*\/\s*[A-Za-z0-9]+/);
  if (slashMatch) {
    const head = slashMatch[1];
    return /^\d+$/.test(head) ? head.replace(/^0+(?=\d)/, "") : head;
  }
  const numberMatch = trimmed.match(/^#?\s*([A-Za-z0-9]+)/);
  if (numberMatch) {
    const head = numberMatch[1];
    return /^\d+$/.test(head) ? head.replace(/^0+(?=\d)/, "") : head;
  }
  return trimmed;
}

function normalizeCardNumberForCompare(raw: string | null | undefined): string | null {
  // Same rules as parseCardNumberFilter but applied to canonical_cards
  // values too, so "70" filter matches "070" stored values and vice
  // versa. Defense against database/print drift.
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return /^\d+$/.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, "") : trimmed;
}

/**
 * Normalize a free-text set hint from on-device OCR for fuzzy
 * matching against canonical_cards.set_name. Lowercases, collapses
 * whitespace, strips punctuation. Returns null for short/noisy input
 * so we don't filter on a 2-character OCR misread.
 */
function parseSetHintFilter(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length < 3) return null; // 2-char OCR misreads are pure noise
  return trimmed;
}

function normalizeSetNameForCompare(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True if the operator-supplied OCR set hint plausibly refers to
 * `set_name` from canonical_cards. Case- and punctuation-insensitive
 * containment check in either direction so "phantasmal flames" hint
 * matches "Phantasmal Flames" stored AND "Pokemon GO" hint matches
 * the longer printed-on-card "Pokemon GO Booster" if that ever drifts.
 */
function setHintMatches(hint: string, storedSetName: string | null | undefined): boolean {
  if (!hint) return true; // no hint → no filter
  const stored = normalizeSetNameForCompare(storedSetName);
  if (stored.length === 0) return false;
  return stored.includes(hint) || hint.includes(stored);
}

function classifyConfidence(
  topDistance: number | undefined,
  gap: number | null,
  context: {
    cardNumberFilterApplied: boolean;
    ocrChangedTop1: boolean;
  },
): "high" | "medium" | "low" {
  if (topDistance === undefined) return "low";
  // High requires both absolute closeness AND a meaningful margin over
  // rank-2. A tight cluster with ambiguous gap (e.g. Charizard ex vs
  // Charizard V) should fall to medium so the user confirms.
  if (topDistance <= CONFIDENCE_HIGH_COS_DIST) {
    // Default rule: gap-null is treated as "uncontested rank-1" → high.
    // EXCEPTION (2026-04-29 trust-killer fix): when the OCR card_number
    // filter narrowed candidates to exactly 1, gap is null because we
    // *removed* the rank-2 — not because no rank-2 was naturally close.
    // If that surviving candidate ALSO replaced what CLIP originally
    // had as top-1, the route is essentially trusting OCR over CLIP.
    // OCR is independently fallible (real-device test 2026-04-29 hit
    // Umbreon V #94 → "Suicune & Entei LEGEND #94" at HIGH confidence
    // because OCR read the right number on the wrong card cluster).
    // Downgrade to medium so the user confirms instead of getting
    // auto-navigated. When CLIP's top-1 also satisfied the OCR filter
    // (the common case), both signals agree and HIGH still applies.
    if (context.cardNumberFilterApplied && context.ocrChangedTop1 && gap === null) {
      return "medium";
    }
    if (gap === null || gap >= CONFIDENCE_HIGH_MIN_GAP) return "high";
    return "medium";
  }
  if (topDistance <= CONFIDENCE_MEDIUM_COS_DIST) return "medium";
  return "low";
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const actorKey = req.headers.get("x-pa-actor-key");
  const clientPlatform = req.headers.get("x-pa-client-platform");

  // Parsed up-front so all failure paths — including pre-body
  // validation — can include language_filter in their PostHog event.
  // parseLanguage defaults to "EN", so this is safe even if the iOS
  // client forgets the query param.
  const { searchParams } = new URL(req.url);
  const language = parseLanguage(searchParams.get("language"));
  const limit = parseLimit(searchParams.get("limit"));
  // Optional collector-number filter. Populated by the iOS app's
  // on-device Vision text-recognition before upload. When unset the
  // route behaves identically to pre-OCR.
  const cardNumberFilter = parseCardNumberFilter(searchParams.get("card_number"));
  // Optional set-name hint, also from on-device Vision OCR. Pairs with
  // card_number to disambiguate cases where two cards share the same
  // collector number across different sets — e.g. Umbreon V #94 (Evolving
  // Skies) vs Suicune & Entei LEGEND #94 (HS Unleashed). A correct OCR
  // read of "Evolving Skies" picks Umbreon. Free-text contains-match
  // (in either direction) against canonical_cards.set_name, so e.g.
  // "PE" abbreviation isn't useful but "Prismatic Evolutions" is.
  const setHintFilter = parseSetHintFilter(searchParams.get("set_hint"));

  if (!hasVercelPostgresConfig()) {
    emitScanFailureEvent({
      actorKey,
      clientPlatform,
      language,
      failureReason: "config_missing",
      httpStatus: 503,
      durationMs: Date.now() - startedAt,
      imageBytesSize: null,
    });
    return NextResponse.json(
      { ok: false, error: "Image embeddings database is not configured." },
      { status: 503 },
    );
  }

  if (!hasReplicateConfig()) {
    emitScanFailureEvent({
      actorKey,
      clientPlatform,
      language,
      failureReason: "replicate_unavailable",
      httpStatus: 503,
      durationMs: Date.now() - startedAt,
      imageBytesSize: null,
    });
    return NextResponse.json(
      { ok: false, error: "Embedder is not configured." },
      { status: 503 },
    );
  }

  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
    emitScanFailureEvent({
      actorKey,
      clientPlatform,
      language,
      failureReason: "bad_content_type",
      httpStatus: 415,
      durationMs: Date.now() - startedAt,
      imageBytesSize: null,
    });
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
      emitScanFailureEvent({
        actorKey,
        clientPlatform,
        language,
        failureReason: "body_empty",
        httpStatus: 400,
        durationMs: Date.now() - startedAt,
        imageBytesSize: 0,
      });
      return NextResponse.json(
        { ok: false, error: "Empty request body." },
        { status: 400 },
      );
    }
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      emitScanFailureEvent({
        actorKey,
        clientPlatform,
        language,
        failureReason: "body_too_large",
        httpStatus: 413,
        durationMs: Date.now() - startedAt,
        imageBytesSize: arrayBuffer.byteLength,
      });
      return NextResponse.json(
        { ok: false, error: `Image exceeds ${MAX_IMAGE_BYTES} byte limit.` },
        { status: 413 },
      );
    }
    bytes = Buffer.from(arrayBuffer);
  } catch {
    emitScanFailureEvent({
      actorKey,
      clientPlatform,
      language,
      failureReason: "body_read_failed",
      httpStatus: 400,
      durationMs: Date.now() - startedAt,
      imageBytesSize: null,
    });
    return NextResponse.json(
      { ok: false, error: "Failed to read request body." },
      { status: 400 },
    );
  }

  const imageHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const imageBytesSize = bytes.length;

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
        httpStatus: 503,
        failureReason: "embedder_config",
      });
      return NextResponse.json({ ok: false, error: err.message }, { status: 503 });
    }
    throw err;
  }

  // ── Multi-crop ensemble ────────────────────────────────────────────
  //
  // Two parallel pipelines per scan:
  //   • full   — original captured bytes (existing path)
  //   • art    — server-side art-only crop (top 62% of card height,
  //              excluding the footer/collector-number region)
  //
  // Each pipeline embeds via Replicate, kNNs against pgvector with a
  // crop_type filter, and the two result sets are merged max-by-slug
  // (per slug, keep the closer of the two cos_dists). The art branch
  // recovers cards whose footer is occluded by a finger — the
  // dominant real-world failure mode flagged in
  // docs/scanner-augmentation-playbook.md and exercised by the
  // 2026-04-26 user-reported "Cramorant with finger covering corner"
  // miss.
  //
  // Graceful degradation: any failure on the art branch (crop fails,
  // upload fails, embed returns null, kNN errors) is logged and
  // skipped — the route still returns full-only matches. The art
  // branch is "additive when present, no-op when absent." Only the
  // full branch is load-bearing for correctness.

  const supabase = dbAdmin();
  const scanFullKey = `scan-uploads/${imageHash}.jpg`;
  const scanArtKey = `scan-uploads/${imageHash}-art.jpg`;

  // 0. Resize the captured photo to a Replicate-fetchable size. iPhone
  //    full-res JPEGs (1-2 MB) caused Replicate's CLIP fetch to fail
  //    with `ended in status=failed: You have to specify either text
  //    or images. Both cannot be none.` — the model's URL fetch came
  //    back empty/truncated for large public-bucket URLs. Capping at
  //    800px long-edge / JPEG q=88 fixes this with no measurable
  //    accuracy loss (CLIP downsamples to 224×224 internally anyway).
  //    Both the full-upload and the art-crop branches consume this
  //    resized version so they see the same input.
  let uploadBytes: Buffer;
  try {
    uploadBytes = await resizeForUpload(bytes);
  } catch (err) {
    console.warn(
      `[identify] resize-for-upload failed hash=${imageHash}, falling back to original bytes: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    uploadBytes = bytes;
  }

  // 1. Generate the art crop server-side from the resized input.
  //    Determinism is critical: the embed-card-art-crops cron uses
  //    the same applyCropTransform, so reference embeddings and query
  //    embeddings end up in the same CLIP feature manifold. (Cron-side
  //    inputs are already small Scrydex catalog images, so the resize
  //    step above is a no-op for them.)
  let artBytes: Buffer | null = null;
  try {
    artBytes = await applyCropTransform("art", uploadBytes);
  } catch (err) {
    if (err instanceof ImageCropError) {
      // Tiny / malformed images degrade to single-crop. Logged so we
      // can spot patterns in real-world rejections.
      console.warn(
        `[identify] art-crop skipped hash=${imageHash}: ${err.message}`,
      );
    } else {
      // Any other crop error is surfaced but still degrades gracefully.
      console.warn(
        `[identify] art-crop error hash=${imageHash}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Upload both crops to Storage in parallel. Idempotent uploads
  //    keyed by hash — re-scanning the same image is a no-op.
  const fullUploadPromise = supabase.storage
    .from("card-images")
    .upload(scanFullKey, uploadBytes, {
      upsert: true,
      contentType: "image/jpeg",
      cacheControl: "no-cache",
    });
  const artUploadPromise = artBytes
    ? supabase.storage
        .from("card-images")
        .upload(scanArtKey, artBytes, {
          upsert: true,
          contentType: "image/jpeg",
          cacheControl: "no-cache",
        })
    : Promise.resolve({ error: null });

  const [fullUpload, artUpload] = await Promise.all([
    fullUploadPromise,
    artUploadPromise,
  ]);

  // Full upload failure is fatal — without it Replicate has nothing
  // to fetch and we can't return matches. Match the previous status
  // codes / failure_reason so existing PostHog alerts keep firing.
  if (fullUpload.error) {
    await logScanEvent({
      imageHash,
      imageBytesSize,
      language,
      confidence: "error",
      modelVersion: embedder.modelVersion,
      durationMs: Date.now() - startedAt,
      error: `Storage upload failed: ${fullUpload.error.message}`.slice(0, 500),
      actorKey,
      clientPlatform,
      httpStatus: 502,
      failureReason: "storage_upload_failed",
    });
    return NextResponse.json(
      { ok: false, error: `Storage upload failed: ${fullUpload.error.message}` },
      { status: 502 },
    );
  }

  // Art upload failure → degrade to single-crop. Log so we know.
  const artUploadFailed = artBytes !== null && artUpload.error !== null;
  if (artUploadFailed) {
    console.warn(
      `[identify] art upload failed hash=${imageHash}: ${artUpload.error?.message ?? "?"}`,
    );
  }

  const fullPublicUrl = supabase.storage
    .from("card-images")
    .getPublicUrl(scanFullKey).data.publicUrl;
  const artPublicUrl =
    artBytes && !artUploadFailed
      ? supabase.storage.from("card-images").getPublicUrl(scanArtKey).data.publicUrl
      : null;

  // 3. Embed both URLs in a single batch call to Replicate.
  //    embedUrls supports arrays (REPLICATE_CLIP_DEFAULT_BATCH_SIZE=8;
  //    we're sending 1-2). Batching amortizes cold-start over both
  //    crops — meaningfully cheaper than two sequential calls when
  //    Replicate is cold.
  const urlsToEmbed: string[] = [fullPublicUrl];
  if (artPublicUrl) urlsToEmbed.push(artPublicUrl);

  let fullEmbedding: number[];
  let artEmbedding: number[] | null = null;
  try {
    const results = await embedder.embedUrls(urlsToEmbed);
    const fullResult = results[0];
    if (!fullResult || fullResult.embedding === null) {
      const message = fullResult?.error ?? "embedder returned no result";
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
        httpStatus: 502,
        failureReason: "embedder_returned_null",
      });
      return NextResponse.json(
        { ok: false, error: `Embedder failure: ${message}` },
        { status: 502 },
      );
    }
    fullEmbedding = fullResult.embedding;

    // Art branch failure is non-fatal.
    if (artPublicUrl) {
      const artResult = results[1];
      if (artResult && artResult.embedding) {
        artEmbedding = artResult.embedding;
      } else {
        console.warn(
          `[identify] art embed returned null hash=${imageHash}: ${artResult?.error ?? "no result"}`,
        );
      }
    }
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
        httpStatus: 502,
        failureReason: "embedder_runtime_error",
      });
      return NextResponse.json(
        { ok: false, error: `Embedder failure: ${err.message}` },
        { status: 502 },
      );
    }
    throw err;
  }

  if (fullEmbedding.length !== embedder.dimensions) {
    const message = `Embedder returned unexpected dimensions: ${fullEmbedding.length} vs ${embedder.dimensions}`;
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
      httpStatus: 502,
      failureReason: "embedding_dimension_mismatch",
    });
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  // Defensive: if the art embedding came back with a wrong dimension
  // (shouldn't happen with the same model, but cheap to check), drop
  // it and degrade. Don't fail the whole scan over an art-branch
  // anomaly.
  if (artEmbedding && artEmbedding.length !== embedder.dimensions) {
    console.warn(
      `[identify] art embedding dim mismatch hash=${imageHash}: ${artEmbedding.length} vs ${embedder.dimensions}`,
    );
    artEmbedding = null;
  }

  const fullVectorLiteral = `[${fullEmbedding.join(",")}]`;
  const artVectorLiteral = artEmbedding ? `[${artEmbedding.join(",")}]` : null;

  // 4. Two parallel pgvector kNN queries. Each filters by crop_type so
  //    the full-card query embeds against full-card references and the
  //    art-crop query embeds against art-crop references — apples-to-
  //    apples within each branch. Same dedup-by-slug + 4× overfetch as
  //    the prior single-crop path; existing reasoning about Pokemon
  //    augmentation variants and TCG Pocket exclusion is unchanged.
  let fullMatches: MatchRow[] = [];
  let artMatches: MatchRow[] = [];
  try {
    const queries: Array<Promise<{ rows: MatchRow[] }>> = [
      sql.query<MatchRow>(
        KNN_QUERY,
        [fullVectorLiteral, embedder.modelVersion, language, limit, "full"],
      ),
    ];
    if (artVectorLiteral) {
      queries.push(
        sql.query<MatchRow>(
          KNN_QUERY,
          [artVectorLiteral, embedder.modelVersion, language, limit, "art"],
        ),
      );
    }
    const results = await Promise.all(queries);
    fullMatches = results[0].rows;
    if (results.length > 1) artMatches = results[1].rows;
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
      httpStatus: 500,
      failureReason: "pgvector_query_failed",
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  // 5. Merge across the two branches with a re-rank-only constraint.
  //
  //    Per canonical_slug, keep whichever branch returned the closer
  //    cos_dist (higher similarity). BUT: art can only update slugs
  //    that already appear in full's top-K — art-only candidates are
  //    dropped.
  //
  //    Why: with selective art-crop reference coverage (~1,164 of
  //    ~19,000 slugs in the index right now), the art kNN for a
  //    query whose true answer ISN'T in the covered subset will
  //    return the best-fitting WRONG attention card with high
  //    similarity. In a vanilla max-by-slug merge, that wrong card
  //    can outrank the correct full-card match. We measured this
  //    empirically on 2026-04-27: vanilla multi-crop regressed the
  //    eval from 4/12 to 2/12 top-1, and made several wrong matches
  //    MORE confident than the prior single-crop run.
  //
  //    Re-rank-only constraint: art can boost slugs full found,
  //    cannot introduce new ones. For attention-set cards (the
  //    coverage we have), full's kNN finds the right slug in top-K
  //    most of the time and art picks among those — useful when
  //    art's signal disambiguates within full's candidate set
  //    (e.g. variant ambiguity). For non-attention cards, art's
  //    noise is filtered out and the route degrades to full-only.
  //
  //    Future: if we drain the full ~19,000-slug catalog with art
  //    crops, flip MULTI_CROP_ART_REQUIRES_FULL_MATCH to false and
  //    the merge becomes additive (art can recover slugs full
  //    missed entirely). Until then, re-rank-only is the safer
  //    default.
  const MULTI_CROP_ART_REQUIRES_FULL_MATCH = true;

  const slugToBest = new Map<string, MatchWithCrop>();
  for (const row of fullMatches) {
    slugToBest.set(row.canonical_slug, { ...row, winning_crop: "full" });
  }
  let artOnlyDropped = 0;
  for (const row of artMatches) {
    const existing = slugToBest.get(row.canonical_slug);
    if (!existing) {
      if (MULTI_CROP_ART_REQUIRES_FULL_MATCH) {
        artOnlyDropped += 1;
        continue;
      }
      slugToBest.set(row.canonical_slug, { ...row, winning_crop: "art" });
      continue;
    }
    if (row.cos_dist < existing.cos_dist) {
      slugToBest.set(row.canonical_slug, { ...row, winning_crop: "art" });
    }
  }
  // Logged at debug level rather than persisted — useful when staring
  // at Vercel logs after a regression, but not worth a column.
  if (artOnlyDropped > 0) {
    console.log(
      `[identify] art-only candidates dropped (re-rank-only mode): ${artOnlyDropped} hash=${imageHash}`,
    );
  }
  const allMergedMatches: MatchWithCrop[] = [...slugToBest.values()]
    .sort((a, b) => a.cos_dist - b.cos_dist);

  // ── Orphan filter ─────────────────────────────────────────────────
  //
  // The card_image_embeddings index (Neon) and canonical_cards (Supabase)
  // can drift: an embedding row may persist after its canonical_cards
  // parent is deleted (slug rename, dedup, retracted printing). When
  // that happens the kNN happily returns the orphan slug as a top-N
  // result, but the iOS app can't navigate to a /cards/<slug> that
  // doesn't exist. Worse, the orphan crowds out legitimate candidates.
  //
  // 2026-04-28 baseline eval: 6 of 65 wrong predictions returned slugs
  // missing from canonical_cards (~9% of misses). All 6 looked plausible
  // to CLIP but weren't navigable.
  //
  // We resolve the merged top-K candidate set against canonical_cards
  // and keep only the present ones. The pre-merge over-fetch (4× in the
  // kNN CTE) gives us headroom — the K-after-filter is usually still ≥
  // the requested limit even after dropping orphans. When it isn't, we
  // return what we have rather than silently padding with low-quality
  // matches we know are wrong.
  let orphansDropped = 0;
  let cardNumberDropped = 0;
  let cardNumberFilterApplied = false;
  let setHintFilterApplied = false;
  let setHintDropped = 0;
  // CLIP's choice of top-1 BEFORE the card_number filter ran. Used by
  // confidence classification to detect "OCR overrode CLIP" — when
  // they agree, HIGH stays earned; when they disagree, the route is
  // trusting OCR alone, which is independently fallible (real-device
  // 2026-04-29 hit Umbreon V #94 → "Suicune & Entei LEGEND #94"
  // because OCR read 94 on the wrong card cluster). See
  // classifyConfidence for the downgrade rule.
  let clipOriginalTopSlug: string | null = null;
  let matches: MatchWithCrop[];
  // Map of slug → canonical_cards.mirrored_primary_image_url. Populated
  // by the orphan-filter Supabase round-trip below and used when we
  // build the response so the iOS app sees the CLEAN catalog image, not
  // whichever augmentation variant happened to win the kNN. Before
  // 2026-04-29 we returned card_image_embeddings.source_image_url
  // directly — that meant a v4-thumb-overlay match showed the operator
  // a synthetic-thumb-glared preview, hiding which card the system
  // actually identified. Empty map ⇒ degrade to source_image_url
  // (the previous behavior) per the same fail-graceful contract as the
  // orphan filter.
  const canonicalImageBySlug = new Map<string, string | null>();
  // Maps populated by the orphan-filter Supabase round-trip below and
  // consumed by the optional card_number / set_hint filters. Always
  // populated (cheap; the SELECT has them) so adding new filters
  // doesn't require another round-trip.
  const canonicalCardNumberBySlug = new Map<string, string | null>();
  const canonicalSetNameBySlug = new Map<string, string | null>();
  if (allMergedMatches.length === 0) {
    matches = [];
  } else {
    const candidateSlugs = allMergedMatches.map((m) => m.canonical_slug);
    const { data: presentRows, error: presenceErr } = await supabase
      .from("canonical_cards")
      .select("slug, mirrored_primary_image_url, card_number, set_name")
      .in("slug", candidateSlugs);

    if (presenceErr) {
      // Don't fail the scan over the orphan filter — log and degrade
      // to "trust the kNN output" (existing pre-filter behavior).
      console.warn(
        `[identify] canonical-cards presence check failed hash=${imageHash}: ${presenceErr.message}`,
      );
      matches = allMergedMatches.slice(0, limit);
    } else {
      const presentSet = new Set((presentRows ?? []).map((r) => r.slug));
      for (const row of presentRows ?? []) {
        canonicalImageBySlug.set(row.slug, row.mirrored_primary_image_url ?? null);
        canonicalCardNumberBySlug.set(row.slug, row.card_number ?? null);
        canonicalSetNameBySlug.set(row.slug, row.set_name ?? null);
      }
      const orphanFiltered = allMergedMatches.filter((m) => presentSet.has(m.canonical_slug));
      orphansDropped = allMergedMatches.length - orphanFiltered.length;
      if (orphansDropped > 0) {
        console.log(
          `[identify] orphan slugs dropped (not in canonical_cards): ${orphansDropped} hash=${imageHash}`,
        );
      }
      // Capture CLIP's top-1 choice BEFORE the OCR filter runs so the
      // confidence classifier can detect "OCR overrode CLIP" cases.
      clipOriginalTopSlug = orphanFiltered[0]?.canonical_slug ?? null;

      // ── Optional card_number filter ─────────────────────────────────
      // When the request supplies a card_number (currently: eval harness
      // simulating perfect OCR; future: iOS Vision pre-extraction), we
      // narrow the candidate set to only canonical_cards rows whose
      // card_number matches. This is structurally how V vs VMAX vs ex
      // confusion gets resolved: CLIP can't read the printed number,
      // but if the client extracted "44" from the photo, we filter
      // among Pikachu candidates to {Pikachu VMAX (#44)} instead of
      // returning {Pikachu V (#43)}.
      //
      // Fail-graceful: if the filter drops everything (OCR was wrong /
      // canonical_cards is missing the number / format mismatch), fall
      // back to the orphan-filtered candidates. Better to return a
      // CLIP-best guess than nothing.
      let postFilter = orphanFiltered;
      if (cardNumberFilter) {
        cardNumberFilterApplied = true;
        const target = normalizeCardNumberForCompare(cardNumberFilter);
        const numFiltered = orphanFiltered.filter((m) => {
          const stored = canonicalCardNumberBySlug.get(m.canonical_slug);
          return normalizeCardNumberForCompare(stored) === target;
        });
        cardNumberDropped = orphanFiltered.length - numFiltered.length;
        if (numFiltered.length === 0) {
          console.log(
            `[identify] card_number filter '${cardNumberFilter}' dropped all candidates — degrading to orphan-filtered set hash=${imageHash}`,
          );
        } else {
          postFilter = numFiltered;
          if (cardNumberDropped > 0) {
            console.log(
              `[identify] card_number filter '${cardNumberFilter}' kept ${numFiltered.length}/${orphanFiltered.length} hash=${imageHash}`,
            );
          }
        }
      }

      // ── Optional set_hint filter ────────────────────────────────────
      // Layered AFTER card_number so when both are present we get a
      // strict (number, set) intersect — the killer case for shared
      // collector numbers across sets (Umbreon V #94 Evolving Skies vs
      // Suicune & Entei LEGEND #94 HS Unleashed; Nidoking #11 Base vs
      // Base Set 2). Set hints are noisy (OCR may pull anything from
      // the card art), so the filter is fail-graceful: if it drops
      // every candidate, we keep whatever the card_number filter (or
      // upstream orphan filter) produced.
      if (setHintFilter) {
        setHintFilterApplied = true;
        const beforeSetFilter = postFilter;
        const setFiltered = postFilter.filter((m) => {
          const stored = canonicalSetNameBySlug.get(m.canonical_slug);
          return setHintMatches(setHintFilter, stored);
        });
        setHintDropped = beforeSetFilter.length - setFiltered.length;
        if (setFiltered.length === 0) {
          console.log(
            `[identify] set_hint filter '${setHintFilter}' dropped all candidates — degrading hash=${imageHash}`,
          );
        } else {
          postFilter = setFiltered;
          if (setHintDropped > 0) {
            console.log(
              `[identify] set_hint filter '${setHintFilter}' kept ${setFiltered.length}/${beforeSetFilter.length} hash=${imageHash}`,
            );
          }
        }
      }
      matches = postFilter.slice(0, limit);
    }
  }

  // ── Day 2: layered two-stage OCR-first retrieval ────────────────────
  //
  // The post-kNN filter pipeline above (Day 1) hit a hard ceiling at
  // 57.4% top-1 on the 277-image eval — filters can only narrow what
  // kNN already returned, and CLIP's top-K simply doesn't contain the
  // right card for ~42% of failure cases. Day 2 attacks this by
  // bypassing kNN ENTIRELY when OCR has enough signal:
  //
  //   Path A (strict)   — card_number + set_hint both present:
  //                        SELECT canonical_cards WHERE card_number=N
  //                        AND set_name ILIKE %hint%. 1 row → HIGH.
  //                        2-3 rows → intersect with kNN ordering,
  //                        return MEDIUM. >3 → fall through.
  //
  //   Path B (middle)   — card_number only (set OCR failed):
  //                        SELECT canonical_cards WHERE
  //                        card_number=N (could be 100+ slugs across
  //                        sets globally). Intersect with the kNN
  //                        candidate pool. Unique survivor → HIGH
  //                        (CLIP + OCR agree). 2-3 → MEDIUM.
  //                        0 → fall through to Path C.
  //
  //   Path C (fallback) — current pipeline output (`matches`).
  //                        Already built above.
  //
  // We always run both kNN AND the OCR-direct lookup; choosing
  // between paths is purely a decision over their results. Future
  // optimization could short-circuit the embed/kNN when Path A
  // unique fires (saves ~3s of Replicate latency), but for the first
  // ship we prefer the simpler path-selection logic.
  let winningPath: WinningPath = "vision_only";

  if (cardNumberFilter) {
    const normalizedNumber = normalizeCardNumberForCompare(cardNumberFilter);
    let directQuery = supabase
      .from("canonical_cards")
      .select("slug, canonical_name, language, set_name, card_number, variant, mirrored_primary_image_url")
      .eq("language", language)
      .limit(50); // bounded to keep memory + intersect cost predictable

    if (normalizedNumber) {
      directQuery = directQuery.eq("card_number", normalizedNumber);
    }

    const directResult = await directQuery;

    if (directResult.error) {
      console.warn(
        `[identify] OCR-direct lookup failed hash=${imageHash}: ${directResult.error.message}`,
      );
    } else {
      const directRows: CanonicalRow[] = (directResult.data ?? []) as CanonicalRow[];

      // Apply set_hint filter if iOS provided one.
      const setMatching = setHintFilter
        ? directRows.filter((r) => setHintMatches(setHintFilter, r.set_name))
        : directRows;

      if (setHintFilter && setMatching.length > 0 && setMatching.length <= 3) {
        // Path A: strict (card_number AND set_hint).
        if (setMatching.length === 1) {
          // Path A unique → HIGH-confidence direct answer. Synthesize
          // a match from the canonical row; cos_dist=0 yields
          // similarity=1.0, which is honest because we did NOT use
          // CLIP's similarity for this decision — the iOS app reads
          // the response and treats it identically to a kNN HIGH.
          matches = [canonicalRowToMatch(setMatching[0], 0)];
          winningPath = "ocr_direct_unique";
        } else {
          // Path A narrow: 2-3 rows. Use kNN's existing ordering to
          // rank within the surviving set. allMergedMatches has the
          // full kNN output (with cos_dist sortable); pull whichever
          // of the survivors appear there. Survivors not in kNN keep
          // sentinel cos_dist=0.5 (mid-tier) so they sort below CLIP-
          // confirmed matches but above unknown.
          const ranked = setMatching.map((r) => {
            const knn = allMergedMatches.find((m) => m.canonical_slug === r.slug);
            return knn ?? canonicalRowToMatch(r, 0.5);
          });
          ranked.sort((a, b) => a.cos_dist - b.cos_dist);
          matches = ranked.slice(0, limit);
          winningPath = "ocr_direct_narrow";
        }
      } else if (!setHintFilter && directRows.length > 0) {
        // Path B: card_number only. Intersect direct-query slugs
        // with the kNN candidate pool. The kNN's allMergedMatches
        // is up to ~20 unique slugs (4× over-fetch + slug dedup).
        const directSlugSet = new Set(directRows.map((r) => r.slug));
        const intersect = allMergedMatches.filter((m) =>
          directSlugSet.has(m.canonical_slug),
        );

        if (intersect.length === 1) {
          // Path B unique → HIGH (dual-signal: OCR + CLIP agree).
          matches = [intersect[0]];
          winningPath = "ocr_intersect_unique";
        } else if (intersect.length >= 2 && intersect.length <= 3) {
          // Path B narrow: kNN already ranked these; just slice.
          matches = intersect.slice(0, limit);
          winningPath = "ocr_intersect_narrow";
        }
        // 0 → fall through to vision_only
        // >3 → too noisy for Path B, also fall through
      }
      // Path A returned >3 rows OR Path A returned 0 with set_hint
      // present → fall through to vision_only too.
    }
  }

  // Per-branch top similarities BEFORE merge — preserved for
  // telemetry so we can see whether the two branches agreed or one
  // dragged the other.
  const fullTopSimilarity = fullMatches[0] ? 1 - fullMatches[0].cos_dist : null;
  const artTopSimilarity = artMatches[0] ? 1 - artMatches[0].cos_dist : null;

  // Winning crop on the merged top-1. "tie" when both branches
  // returned the same top slug (informative — means the art branch
  // didn't add new signal, but didn't subtract either).
  let winningCrop: "full" | "art" | "tie" | null = null;
  if (matches[0]) {
    const fullTop = fullMatches[0]?.canonical_slug;
    const artTop = artMatches[0]?.canonical_slug;
    if (fullTop && artTop && fullTop === artTop) {
      winningCrop = "tie";
    } else {
      winningCrop = matches[0].winning_crop;
    }
  }

  const topDistance = matches[0]?.cos_dist;
  const topSimilarity = matches[0] ? 1 - matches[0].cos_dist : null;
  const rank2 = matches[1];
  const rank2Similarity = rank2 ? 1 - rank2.cos_dist : null;
  const topGap =
    topSimilarity !== null && rank2Similarity !== null
      ? topSimilarity - rank2Similarity
      : null;

  // Confidence tier — the rules differ between Day 2 paths and the
  // legacy vision_only pipeline:
  //
  //   ocr_direct_unique    HIGH (OCR pulled both card_number AND set;
  //                        canonical_cards row was unique. Both signals
  //                        agreed independently of CLIP. No
  //                        trust-killer concern because the route did
  //                        NOT have to override CLIP — it bypassed
  //                        CLIP entirely.)
  //   ocr_direct_narrow    MEDIUM (2-3 rows survived; user confirms.)
  //   ocr_intersect_unique HIGH (CLIP top-K and OCR card_number
  //                        intersected to one slug — dual-signal
  //                        agreement.)
  //   ocr_intersect_narrow MEDIUM.
  //   vision_only          — Day 1 logic: if OCR filter changed CLIP's
  //                        original top-1 AND gap is null, downgrade
  //                        HIGH→MEDIUM (the trust-killer fix); else
  //                        fall through to the cos_dist+gap rules.
  let confidence: "high" | "medium" | "low";
  if (winningPath === "ocr_direct_unique" || winningPath === "ocr_intersect_unique") {
    confidence = "high";
  } else if (winningPath === "ocr_direct_narrow" || winningPath === "ocr_intersect_narrow") {
    confidence = "medium";
  } else {
    // Detect "OCR overrode CLIP": EITHER OCR filter narrowed
    // candidates AND the surviving top-1 was NOT what CLIP originally
    // ranked first. When this happens AND gap is null, downgrade
    // HIGH→MEDIUM (Day 1 trust-killer fix in 5f2df4f).
    const ocrFilterApplied = cardNumberFilterApplied || setHintFilterApplied;
    const ocrChangedTop1 =
      ocrFilterApplied &&
      clipOriginalTopSlug !== null &&
      matches[0] != null &&
      matches[0].canonical_slug !== clipOriginalTopSlug;
    confidence = classifyConfidence(topDistance, topGap, {
      cardNumberFilterApplied: ocrFilterApplied,
      ocrChangedTop1,
    });
  }

  await logScanEvent({
    imageHash,
    imageBytesSize,
    language,
    confidence,
    matchCount: matches.length,
    topMatchSlug: matches[0]?.canonical_slug ?? null,
    topSimilarity,
    topGapToRank2: topGap,
    rank2Slug: rank2?.canonical_slug ?? null,
    rank2Similarity,
    modelVersion: embedder.modelVersion,
    durationMs: Date.now() - startedAt,
    actorKey,
    clientPlatform,
    httpStatus: 200,
    failureReason: null,
    fullTopSimilarity,
    artTopSimilarity,
    winningCrop,
    winningPath,
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
      // Prefer the canonical (clean) catalog image over the kNN row's
      // own source_image_url. The kNN row may have won via an
      // augmentation variant whose URL points at e.g.
      // augmented/<slug>/v1-augv1-phone-warm.jpg — showing that to the
      // operator is misleading because the iOS card detail view of the
      // same slug shows the clean canonical image, so the scanner
      // preview and the navigated detail-view would visibly disagree.
      // The canonicalImageBySlug map was populated by the orphan-filter
      // Supabase round-trip above, so this is free. Falls back to
      // source_image_url for any slug where the orphan-filter lookup
      // failed (rare; fail-graceful path).
      mirrored_primary_image_url:
        canonicalImageBySlug.get(row.canonical_slug) ?? row.source_image_url,
      similarity: Number.isFinite(row.cos_dist) ? 1 - row.cos_dist : 0,
    })),
    language_filter: language,
    model_version: embedder.modelVersion,
    // Returned so the iOS app can later correct a mis-identification
    // (POST /api/admin/scan-eval/promote with this hash and the true
    // canonical_slug). The hash isn't sensitive — just sha256 of the
    // JPEG bytes the client already sent — and it lets us promote the
    // scan into the eval corpus without re-uploading the image.
    image_hash: imageHash,
    // Day 2 retrieval path. Lets the iOS debug overlay show which
    // path fired for each scan; iOS production behavior is
    // unchanged (HIGH/MEDIUM/LOW from `confidence` already drives UX).
    winning_path: winningPath,
  });
}

// MARK: - Telemetry
//
// Best-effort append-only logger. Never throws out of this function —
// a telemetry failure must not fail the scan. Logs to console so ops
// can correlate; the scan identify response is unaffected.
//
// Telemetry fans out two ways:
//   1. scan_identify_events table (DB) — the fine-tuning corpus and
//      operator backfill source. Constrained schema (imageHash NOT
//      NULL etc.) so only post-body paths can write here.
//   2. PostHog — product analytics surface. Every path emits exactly
//      one event (card_scan_succeeded | card_scan_failed). Pre-body
//      validation failures emit via emitScanFailureEvent (PH only).

type ScanEventInput = {
  imageHash: string;
  imageBytesSize: number;
  language: "EN" | "JP";
  confidence: "high" | "medium" | "low" | "error";
  matchCount?: number;
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
  httpStatus: number;
  failureReason: FailureReason | null;
  // Multi-crop telemetry — populated only on the success path. The
  // per-branch top similarities are recorded BEFORE merge so we can
  // see whether the two branches agreed (close numbers, often a
  // "tie") or disagreed (one branch found something the other
  // missed). winningCrop tells us which branch produced the merged
  // top-1 — "tie" when both branches' top-1 was the same slug.
  fullTopSimilarity?: number | null;
  artTopSimilarity?: number | null;
  winningCrop?: "full" | "art" | "tie" | null;
  // Day 2 retrieval path. See WinningPath enum at the top of this
  // file. Lets dashboards measure how often each path fires in
  // production — critical for catching e.g. "Path B never wins
  // because OCR card_number is too noisy" or "Path A unique fires
  // 60% of the time".
  winningPath?: WinningPath | null;
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
        full_top_similarity: event.fullTopSimilarity ?? null,
        art_top_similarity: event.artTopSimilarity ?? null,
        winning_crop: event.winningCrop ?? null,
        winning_path: event.winningPath ?? null,
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

  emitScanPostHog({
    actorKey: event.actorKey ?? null,
    clientPlatform: event.clientPlatform ?? null,
    language: event.language,
    failureReason: event.failureReason,
    httpStatus: event.httpStatus,
    durationMs: event.durationMs,
    imageBytesSize: event.imageBytesSize,
    confidence: event.failureReason ? null : event.confidence,
    matchCount: event.matchCount ?? null,
    topMatchSlug: event.topMatchSlug ?? null,
    topSimilarity: event.topSimilarity ?? null,
    modelVersion: event.modelVersion,
  });
}

// PostHog-only emit for pre-body validation failures (paths where
// imageHash / modelVersion don't exist yet, so the scan_identify_events
// row would violate NOT NULL constraints).
function emitScanFailureEvent(args: {
  actorKey: string | null;
  clientPlatform: string | null;
  language: "EN" | "JP";
  failureReason: FailureReason;
  httpStatus: number;
  durationMs: number;
  imageBytesSize: number | null;
}): void {
  emitScanPostHog({
    actorKey: args.actorKey,
    clientPlatform: args.clientPlatform,
    language: args.language,
    failureReason: args.failureReason,
    httpStatus: args.httpStatus,
    durationMs: args.durationMs,
    imageBytesSize: args.imageBytesSize,
    confidence: null,
    matchCount: null,
    topMatchSlug: null,
    topSimilarity: null,
    modelVersion: null,
  });
}

// Single chokepoint for PostHog scan events. Adding a new property
// here makes it land on every event type. Wrapped so a PostHog
// outage never affects scan results — but logs the failure rather
// than swallowing it (per docs/external-api-failure-modes.md).
function emitScanPostHog(input: {
  actorKey: string | null;
  clientPlatform: string | null;
  language: "EN" | "JP";
  failureReason: FailureReason | null;
  httpStatus: number;
  durationMs: number;
  imageBytesSize: number | null;
  confidence: "high" | "medium" | "low" | "error" | null;
  matchCount: number | null;
  topMatchSlug: string | null;
  topSimilarity: number | null;
  modelVersion: string | null;
}): void {
  // No actor key = probe / curl traffic without iOS ActorStore.
  // Drop rather than create anonymous distinctIds that would pollute
  // the PostHog person table.
  if (!input.actorKey) return;

  const actorType = input.actorKey.startsWith("user:")
    ? "user"
    : input.actorKey.startsWith("guest:")
      ? "guest"
      : "unknown";

  const baseProps: Record<string, unknown> = {
    language_filter: input.language,
    image_size_bytes: input.imageBytesSize,
    duration_ms: input.durationMs,
    http_status: input.httpStatus,
    client_platform: input.clientPlatform,
    actor_type: actorType,
  };

  let eventName: "card_scan_succeeded" | "card_scan_failed";
  let properties: Record<string, unknown>;

  if (input.failureReason) {
    eventName = "card_scan_failed";
    properties = {
      ...baseProps,
      failure_reason: input.failureReason,
    };
  } else {
    eventName = "card_scan_succeeded";
    properties = {
      ...baseProps,
      confidence: input.confidence,
      match_count: input.matchCount,
      top_match_slug: input.topMatchSlug,
      top_match_cos_dist:
        input.topSimilarity !== null ? 1 - input.topSimilarity : null,
      model_version: input.modelVersion,
    };
  }

  try {
    getPostHogClient().capture({
      distinctId: input.actorKey,
      event: eventName,
      properties,
    });
  } catch (err) {
    console.warn(
      `[scan/identify] posthog capture failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
