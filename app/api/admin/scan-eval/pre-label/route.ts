/**
 * POST /api/admin/scan-eval/pre-label
 *
 * Operator endpoint that takes a freshly captured card image, runs
 * Gemini Flash over it to extract printed fields (card name, set,
 * collector number), resolves those fields against canonical_cards
 * to produce ranked slug candidates, and returns the candidates
 * for the operator to confirm.
 *
 * Read-only: this route DOES NOT save anything to scan_eval_images.
 * The companion /api/admin/scan-eval/promote endpoint is the write
 * path. Splitting them lets the UI present pre-labels in a queue,
 * accept some, edit others, and skip the bad ones — without
 * polluting the eval corpus with un-reviewed VLM guesses.
 *
 * Request: multipart/form-data with a single `image` field.
 * Response:
 *   200 {
 *     ok: true,
 *     image_hash: string,                  // sha256 of bytes
 *     image_bytes_size: number,
 *     vlm_guess: VlmCardGuess,             // raw VLM extraction
 *     candidates: [{ slug, canonical_name, set_name, card_number,
 *                    mirrored_primary_image_url, match_score,
 *                    match_reason }, ...up to 5],
 *     match_quality: 'exact' | 'fuzzy' | 'name-only' | 'unmatched',
 *   }
 *   400 — bad request (missing image, invalid content type)
 *   413 — image too big
 *   502 — VLM unavailable / error
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require";
import {
  prelabelCardImage,
  VlmPrelabelError,
  VLM_PRELABEL_VERSION,
} from "@/lib/ai/card-vlm-prelabel";
import { findCanonicalCandidates } from "@/lib/data/canonical-card-match";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/")) {
    return NextResponse.json(
      { ok: false, error: "Request must be multipart/form-data with an 'image' field" },
      { status: 400 },
    );
  }

  let imageBytes: Buffer;
  let imageMimeType: string;
  try {
    const form = await req.formData();
    const imageField = form.get("image");
    if (!(imageField instanceof Blob)) {
      return NextResponse.json(
        { ok: false, error: "image field is required" },
        { status: 400 },
      );
    }
    if (imageField.size === 0) {
      return NextResponse.json({ ok: false, error: "image is empty" }, { status: 400 });
    }
    if (imageField.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { ok: false, error: `image exceeds ${MAX_IMAGE_BYTES} byte limit` },
        { status: 413 },
      );
    }
    imageBytes = Buffer.from(await imageField.arrayBuffer());
    imageMimeType = imageField.type || "image/jpeg";
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `multipart parse failed: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 400 },
    );
  }

  const imageHash = crypto.createHash("sha256").update(imageBytes).digest("hex");

  // VLM extraction — surface any failure cleanly. Per the
  // external-api-failure-modes playbook, no blanket-catch swallowing.
  try {
    const guess = await prelabelCardImage(imageBytes, imageMimeType);
    const matchResult = await findCanonicalCandidates(guess, { limit: 5 });

    return NextResponse.json({
      ok: true,
      image_hash: imageHash,
      image_bytes_size: imageBytes.length,
      vlm_guess: guess,
      candidates: matchResult.candidates,
      match_quality: matchResult.match_quality,
      vlm_version: VLM_PRELABEL_VERSION,
    });
  } catch (err) {
    if (err instanceof VlmPrelabelError) {
      return NextResponse.json(
        {
          ok: false,
          error: `VLM pre-label failed: ${err.message}`,
          image_hash: imageHash,
          image_bytes_size: imageBytes.length,
        },
        { status: 502 },
      );
    }
    throw err;
  }
}
