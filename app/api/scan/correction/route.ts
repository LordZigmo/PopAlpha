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
 *     anchor embed. Doesn't touch scan_eval_images. Premium users
 *     correct their own scans for kNN improvement; admin curation of
 *     the eval corpus stays separate. The conceptual split (anchor
 *     vs. labeled corpus) was conflated in the original /api/admin
 *     route — splitting here keeps the trust model clean and lets
 *     non-admin users feed the anchor flow without elevating the
 *     eval corpus.
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
 *     Fields: canonical_slug, image (JPEG), language?, notes?
 *
 *   JSON + base64 (preferred from iOS — no multipart code needed):
 *     POST /api/scan/correction
 *     Content-Type: application/json
 *     { canonical_slug, image_base64, language?, notes? }
 *
 * Response:
 *   { ok: true, image_hash, model_version, variant_index, skipped }
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
import { resizeForUpload } from "@/lib/ai/image-crops";
import { embedAndStoreUserCorrection } from "@/lib/ai/user-correction-embedding";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const VALID_LANGUAGES = new Set(["EN", "JP"]);

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

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;

  let canonicalSlug: string;
  let imageBytes: Buffer;
  let language: "EN" | "JP";
  let notes: string | null;
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
    } catch {
      return NextResponse.json(
        { ok: false, error: "request body must be JSON or multipart/form-data" },
        { status: 400 },
      );
    }
  }

  // Validate slug exists. Catches typos (and adversarial slugs) before
  // we burn embedder cost.
  const slugCheck = await sql.query<{
    canonical_name: string;
    language: string | null;
    set_name: string | null;
    card_number: string | null;
    variant: string | null;
  }>(
    `select canonical_name, language, set_name, card_number, variant
     from canonical_cards
     where slug = $1
     limit 1`,
    [canonicalSlug],
  );
  if (slugCheck.rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: `canonical_cards.slug = ${canonicalSlug} not found` },
      { status: 404 },
    );
  }
  const canonicalRow = slugCheck.rows[0];

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
