/**
 * POST /api/scan/correction
 *
 * User-gated correction endpoint. When a premium user reports a
 * wrong scan via the picker (the offline scanner's "this isn't right
 * — it's actually X" flow), iOS posts the JPEG bytes + the corrected
 * canonical_slug here. Server creates a `user_correction` row in
 * `card_image_embeddings` so the next sync of the offline catalog
 * picks it up as a kNN anchor.
 *
 * Distinct from /api/admin/scan-eval/promote:
 *   - /api/admin/scan-eval/promote: admin-gated. Writes to
 *     scan_eval_images (the CURATED training corpus) AND fires the
 *     anchor embed. The eval corpus is the input to Stage D
 *     fine-tuning and to the eval runner — it's a hand-labeled
 *     ground-truth dataset.
 *   - /api/scan/correction (this route): user-gated. ONLY fires the
 *     anchor embed AND appends a durable scan_correction_pairs row
 *     with optional predicted metadata supplied by iOS. It doesn't
 *     directly curate scan_eval_images; admin curation of the eval
 *     corpus stays separate. The conceptual split (anchor vs.
 *     labeled corpus) was conflated in the original /api/admin route
 *     — splitting here keeps the trust model clean and lets non-admin
 *     users feed the anchor flow without elevating the eval corpus.
 *
 * The user has the JPEG bytes in memory (from the offline scan).
 * They post multipart with image + canonical_slug. We don't have a
 * scan-uploads/<hash>.jpg counterpart because offline scans never
 * upload — that's fine; embedAndStoreUserCorrection takes bytes
 * directly and the source_image_url it stores is a synthesized
 * supabase:// reference that future eval-pull scripts treat as
 * "anchor-only, no original on disk."
 *
 * Request shape (either form):
 *   Multipart:
 *     POST /api/scan/correction
 *     Content-Type: multipart/form-data
 *     Fields: canonical_slug, image (JPEG), language?, notes?,
 *             from_slug?, confidence?, winning_path?, trigger_source?,
 *             top_similarity?, top_gap?, rank2_slug?, rank2_similarity?,
 *             ocr_card_number_extracted?, ocr_card_numbers_count?
 *
 *   JSON + base64 (preferred from iOS — no multipart code needed):
 *     POST /api/scan/correction
 *     Content-Type: application/json
 *     { canonical_slug, image_base64, language?, notes?,
 *       from_slug?, confidence?, winning_path?, trigger_source?,
 *       top_similarity?, top_gap?, rank2_slug?, rank2_similarity?,
 *       ocr_card_number_extracted?, ocr_card_numbers_count? }
 *
 * Response:
 *   { ok: true, image_hash, model_version, variant_index, skipped,
 *     correction_pair_id, correction_pair_logged }
 *   - skipped: true if an idempotent re-submit (same hash + slug +
 *     model_version already exists). Caller can safely ignore.
 *
 * Trust model:
 *   - requireUser: anyone with a Clerk session. Premium gating is
 *     enforced ON THE CLIENT (only the offline-scanner picker calls
 *     this). Server doesn't enforce premium because we don't yet
 *     have a billing system; per-user rate limits are a future
 *     concern (track userId on the row via created_by).
 *   - The active image embedder (env-driven: SigLIP in production)
 *     stamps the row's model_version, so anchors land in the same
 *     embedding space as the catalog they're meant to enhance.
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { resizeForUpload } from "@/lib/ai/image-crops";
import { embedAndStoreUserCorrection } from "@/lib/ai/user-correction-embedding";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const VALID_LANGUAGES = new Set(["EN", "JP"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low", "error"]);

type CorrectionPredictionMetadata = {
  fromSlug: string | null;
  confidence: "high" | "medium" | "low" | "error" | null;
  winningPath: string | null;
  triggerSource: string | null;
  source: string | null;
  modelVersion: string | null;
  topSimilarity: number | null;
  topGap: number | null;
  rank2Slug: string | null;
  rank2Similarity: number | null;
  ocrCardNumber: string | null;
  ocrSetHint: string | null;
  ocrCardNumberExtracted: boolean | null;
  ocrCardNumbersCount: number | null;
};

type CanonicalRow = {
  canonical_name: string;
  language: string | null;
  set_name: string | null;
  card_number: string | null;
  variant: string | null;
};

function normalizeLanguage(raw: unknown): "EN" | "JP" {
  if (typeof raw !== "string") return "EN";
  const upper = raw.toUpperCase();
  return VALID_LANGUAGES.has(upper) ? (upper as "EN" | "JP") : "EN";
}

function normalizeNotes(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 500);
}

function normalizeOptionalText(raw: unknown, maxLength = 200): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeSlug(raw: unknown): string | null {
  return normalizeOptionalText(raw, 300);
}

function normalizeConfidence(raw: unknown): CorrectionPredictionMetadata["confidence"] {
  if (typeof raw !== "string") return null;
  const lower = raw.toLowerCase();
  return VALID_CONFIDENCE.has(lower)
    ? (lower as CorrectionPredictionMetadata["confidence"])
    : null;
}

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim()
      ? Number(raw)
      : null;
  return value !== null && Number.isFinite(value) ? value : null;
}

function normalizeBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (["true", "1", "yes"].includes(lower)) return true;
  if (["false", "0", "no"].includes(lower)) return false;
  return null;
}

function normalizeNonNegativeInt(raw: unknown): number | null {
  const value = normalizeFiniteNumber(raw);
  if (value === null) return null;
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : null;
}

function firstField(get: (key: string) => unknown, keys: string[]): unknown {
  for (const key of keys) {
    const value = get(key);
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function parsePredictionMetadata(get: (key: string) => unknown): CorrectionPredictionMetadata {
  return {
    fromSlug: normalizeSlug(firstField(get, ["from_slug", "predicted_slug", "top_match_slug"])),
    confidence: normalizeConfidence(get("confidence")),
    winningPath: normalizeOptionalText(get("winning_path"), 80),
    triggerSource: normalizeOptionalText(get("trigger_source"), 80),
    source: normalizeOptionalText(get("source"), 40),
    modelVersion: normalizeOptionalText(get("model_version"), 120),
    topSimilarity: normalizeFiniteNumber(get("top_similarity")),
    topGap: normalizeFiniteNumber(firstField(get, ["top_gap", "top_gap_to_rank_2"])),
    rank2Slug: normalizeSlug(firstField(get, ["rank2_slug", "rank_2_slug"])),
    rank2Similarity: normalizeFiniteNumber(firstField(get, ["rank2_similarity", "rank_2_similarity"])),
    ocrCardNumber: normalizeOptionalText(get("ocr_card_number"), 80),
    ocrSetHint: normalizeOptionalText(get("ocr_set_hint"), 160),
    ocrCardNumberExtracted: normalizeBoolean(get("ocr_card_number_extracted")),
    ocrCardNumbersCount: normalizeNonNegativeInt(firstField(get, ["ocr_card_numbers_count", "ocr_card_count"])),
  };
}

async function findEvalImageId(imageHash: string): Promise<string | null> {
  const { data, error } = await dbAdmin()
    .from("scan_eval_images")
    .select("id")
    .eq("image_hash", imageHash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`[scan/correction] eval-image lookup failed hash=${imageHash.slice(0, 12)}: ${error.message}`);
    return null;
  }
  return typeof data?.id === "string" ? data.id : null;
}

async function logCorrectionPair(args: {
  imageHash: string;
  canonicalSlug: string;
  userId: string;
  notes: string | null;
  metadata: CorrectionPredictionMetadata;
}): Promise<{ id: string | null; logged: boolean }> {
  try {
    const evalImageId = await findEvalImageId(args.imageHash);
    const { data, error } = await dbAdmin()
      .from("scan_correction_pairs")
      .insert({
        image_hash: args.imageHash,
        eval_image_id: evalImageId,
        created_by: args.userId,
        from_slug: args.metadata.fromSlug,
        to_slug: args.canonicalSlug,
        confidence: args.metadata.confidence,
        winning_path: args.metadata.winningPath,
        trigger_source: args.metadata.triggerSource,
        source: args.metadata.source,
        model_version: args.metadata.modelVersion,
        top_similarity: args.metadata.topSimilarity,
        top_gap: args.metadata.topGap,
        rank2_slug: args.metadata.rank2Slug,
        rank2_similarity: args.metadata.rank2Similarity,
        ocr_card_number: args.metadata.ocrCardNumber,
        ocr_set_hint: args.metadata.ocrSetHint,
        ocr_card_number_extracted: args.metadata.ocrCardNumberExtracted,
        ocr_card_numbers_count: args.metadata.ocrCardNumbersCount,
        notes: args.notes,
      })
      .select("id")
      .maybeSingle();

    if (error) {
      console.warn(`[scan/correction] correction-pair insert failed hash=${args.imageHash.slice(0, 12)}: ${error.message}`);
      return { id: null, logged: false };
    }

    return {
      id: typeof data?.id === "string" ? data.id : null,
      logged: true,
    };
  } catch (err) {
    console.warn(
      `[scan/correction] correction-pair unexpected error hash=${args.imageHash.slice(0, 12)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { id: null, logged: false };
  }
}

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;

  let canonicalSlug: string;
  let imageBytes: Buffer;
  let language: "EN" | "JP";
  let notes: string | null;
  let predictionMetadata: CorrectionPredictionMetadata = parsePredictionMetadata(() => null);
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/")) {
    try {
      const form = await req.formData();
      const slugField = form.get("canonical_slug");
      if (typeof slugField !== "string" || !slugField) {
        return NextResponse.json(
          { ok: false, error: "canonical_slug is required" },
          { status: 400 },
        );
      }
      canonicalSlug = slugField;
      const imageField = form.get("image");
      if (!(imageField instanceof Blob)) {
        return NextResponse.json(
          { ok: false, error: "image file is required in multipart body" },
          { status: 400 },
        );
      }
      const buf = Buffer.from(await imageField.arrayBuffer());
      if (buf.length === 0) {
        return NextResponse.json(
          { ok: false, error: "image is empty" },
          { status: 400 },
        );
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { ok: false, error: `image exceeds ${MAX_IMAGE_BYTES} byte limit` },
          { status: 413 },
        );
      }
      imageBytes = buf;
      language = normalizeLanguage(form.get("language"));
      notes = normalizeNotes(form.get("notes"));
      predictionMetadata = parsePredictionMetadata((key) => form.get(key));
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `multipart parse failed: ${err instanceof Error ? err.message : "unknown"}`,
        },
        { status: 400 },
      );
    }
  } else {
    // JSON + base64 path. Same shape iOS uses for promoteEvalFromBytes,
    // so the new ScanService method can share that approach.
    try {
      const body = (await req.json()) as Record<string, unknown>;
      const slug = body.canonical_slug;
      if (typeof slug !== "string" || !slug) {
        return NextResponse.json(
          { ok: false, error: "canonical_slug is required" },
          { status: 400 },
        );
      }
      canonicalSlug = slug;
      const base64 = body.image_base64;
      if (typeof base64 !== "string" || base64.length === 0) {
        return NextResponse.json(
          { ok: false, error: "image_base64 is required" },
          { status: 400 },
        );
      }
      const buf = Buffer.from(base64, "base64");
      if (buf.length === 0) {
        return NextResponse.json(
          { ok: false, error: "image_base64 decoded to empty buffer" },
          { status: 400 },
        );
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { ok: false, error: `image exceeds ${MAX_IMAGE_BYTES} byte limit` },
          { status: 413 },
        );
      }
      imageBytes = buf;
      language = normalizeLanguage(body.language);
      notes = normalizeNotes(body.notes);
      predictionMetadata = parsePredictionMetadata((key) => body[key]);
    } catch {
      return NextResponse.json(
        { ok: false, error: "request body must be JSON or multipart/form-data" },
        { status: 400 },
      );
    }
  }

  // Validate slug exists. Catches typos (and adversarial slugs) before
  // we burn embedder cost.
  const slugCheck = await dbAdmin()
    .from("canonical_cards")
    .select("canonical_name, language, set_name, card_number, variant")
    .eq("slug", canonicalSlug)
    .maybeSingle<CanonicalRow>();

  if (slugCheck.error) {
    return NextResponse.json(
      { ok: false, error: `canonical slug lookup failed: ${slugCheck.error.message}` },
      { status: 500 },
    );
  }
  if (!slugCheck.data) {
    return NextResponse.json(
      { ok: false, error: `canonical_cards.slug = ${canonicalSlug} not found` },
      { status: 404 },
    );
  }
  const canonicalRow = slugCheck.data;

  // Resize + JPEG-encode (also handles HEIC pass-through). Compute
  // the hash from the PROCESSED bytes so the source_hash matches what
  // the anchor row references.
  let processedBytes: Buffer;
  try {
    processedBytes = await resizeForUpload(imageBytes);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `image processing failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 400 },
    );
  }
  const imageHash = crypto.createHash("sha256").update(processedBytes).digest("hex");
  const correctionPair = await logCorrectionPair({
    imageHash,
    canonicalSlug,
    userId,
    notes,
    metadata: predictionMetadata,
  });

  // Embed + store anchor. embedAndStoreUserCorrection is idempotent
  // on (slug, source_hash, model_version), so a re-submit of the same
  // image+slug pair returns skipped=true with no DB write.
  try {
    const result = await embedAndStoreUserCorrection({
      imageBytes: processedBytes,
      imageHash,
      canonicalSlug,
      canonical: {
        canonicalName: canonicalRow.canonical_name,
        language: canonicalRow.language,
        setName: canonicalRow.set_name,
        cardNumber: canonicalRow.card_number,
        variant: canonicalRow.variant,
      },
    });
    console.log(
      `[scan/correction] anchor ${result.skipped ? "exists" : "added"} ` +
        `slug=${canonicalSlug} ` +
        `hash=${imageHash.slice(0, 12)} ` +
        `variant=${result.variantIndex} ` +
        `model=${result.modelVersion} ` +
        `user=${userId} ` +
        `lang=${language}` +
        (notes ? ` notes=${JSON.stringify(notes)}` : ""),
    );
    return NextResponse.json({
      ok: true,
      image_hash: imageHash,
      model_version: result.modelVersion,
      variant_index: result.variantIndex,
      skipped: result.skipped,
      correction_pair_id: correctionPair.id,
      correction_pair_logged: correctionPair.logged,
    });
  } catch (err) {
    console.error(
      `[scan/correction] embed failed slug=${canonicalSlug} hash=${imageHash.slice(0, 12)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NextResponse.json(
      {
        ok: false,
        error: `anchor embed failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}
