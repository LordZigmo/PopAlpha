/**
 * POST /api/admin/scan-eval/promote
 *
 * Operator endpoint for hand-labeling the scanner eval corpus. Accepts
 * either:
 *   (a) image_hash of a previous scan (server copies the object from
 *       scan-uploads/<hash>.jpg into scan-eval/<hash>.jpg) — used when
 *       correcting a mis-identified scan from inside CardDetailView.
 *   (b) image_bytes posted as multipart/form-data — used when seeding
 *       from a fresh photo that hasn't been scanned through
 *       /api/scan/identify yet.
 *
 * Either way we end up with a row in public.scan_eval_images that the
 * eval runner (`npm run eval:run`) uses as ground truth.
 *
 * Requires admin auth (Clerk allowlist). Non-admin Clerk users get 401
 * — the button visible in the iOS app is harmless for them because the
 * server rejects the write.
 *
 * Request shapes:
 *
 *   Case (a): JSON
 *     POST /api/admin/scan-eval/promote
 *     Content-Type: application/json
 *     { canonical_slug, image_hash, captured_source?, captured_language?, notes? }
 *
 *   Case (b): multipart
 *     POST /api/admin/scan-eval/promote
 *     Content-Type: multipart/form-data
 *     Fields: canonical_slug, captured_source?, captured_language?, notes?, image (JPEG)
 *
 * Response: { ok, eval_image_id, storage_path, image_hash, was_upload }
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

const IMAGE_BUCKET = "card-images";
const SCAN_UPLOADS_PREFIX = "scan-uploads";
const SCAN_EVAL_PREFIX = "scan-eval";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const VALID_SOURCES = new Set([
  "user_photo",
  "telemetry",
  "synthetic",
  "roboflow",
  "user_correction",
]);
const VALID_LANGUAGES = new Set(["EN", "JP"]);

function normalizeSource(raw: unknown): string {
  if (typeof raw !== "string") return "user_photo";
  return VALID_SOURCES.has(raw) ? raw : "user_photo";
}

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

function isHexHash64(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

type PromoteInput = {
  canonicalSlug: string;
  imageHash: string | null;
  imageBytes: Buffer | null;
  capturedSource: string;
  capturedLanguage: "EN" | "JP";
  notes: string | null;
  createdBy: string | null;
};

async function parseInput(req: Request, clerkUserId: string): Promise<PromoteInput | { error: string; status: number }> {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.startsWith("multipart/")) {
    try {
      const form = await req.formData();
      const slug = form.get("canonical_slug");
      const imageField = form.get("image");
      if (typeof slug !== "string" || !slug) {
        return { error: "canonical_slug is required", status: 400 };
      }
      if (!(imageField instanceof Blob)) {
        return { error: "image file is required in multipart body", status: 400 };
      }
      const buf = Buffer.from(await imageField.arrayBuffer());
      if (buf.length === 0) return { error: "image is empty", status: 400 };
      if (buf.length > MAX_IMAGE_BYTES) {
        return { error: `image exceeds ${MAX_IMAGE_BYTES} byte limit`, status: 413 };
      }
      return {
        canonicalSlug: slug,
        imageHash: null,
        imageBytes: buf,
        capturedSource: normalizeSource(form.get("captured_source")),
        capturedLanguage: normalizeLanguage(form.get("captured_language")),
        notes: normalizeNotes(form.get("notes")),
        createdBy: clerkUserId,
      };
    } catch (err) {
      return {
        error: `multipart parse failed: ${err instanceof Error ? err.message : "unknown"}`,
        status: 400,
      };
    }
  }

  // JSON path — requires either image_hash (copy from scan-uploads)
  // or image_base64 (treat as fresh upload). iOS takes the base64
  // path to avoid building multipart bodies.
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const slug = body.canonical_slug;
    if (typeof slug !== "string" || !slug) {
      return { error: "canonical_slug is required", status: 400 };
    }

    const capturedSource = normalizeSource(body.captured_source);
    const capturedLanguage = normalizeLanguage(body.captured_language);
    const notes = normalizeNotes(body.notes);

    const hashField = body.image_hash;
    const base64Field = body.image_base64;

    if (typeof base64Field === "string" && base64Field.length > 0) {
      const buf = Buffer.from(base64Field, "base64");
      if (buf.length === 0) {
        return { error: "image_base64 decoded to empty buffer", status: 400 };
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        return { error: `image exceeds ${MAX_IMAGE_BYTES} byte limit`, status: 413 };
      }
      return {
        canonicalSlug: slug,
        imageHash: null,
        imageBytes: buf,
        capturedSource,
        capturedLanguage,
        notes,
        createdBy: clerkUserId,
      };
    }

    if (typeof hashField === "string" && isHexHash64(hashField)) {
      return {
        canonicalSlug: slug,
        imageHash: hashField.toLowerCase(),
        imageBytes: null,
        capturedSource,
        capturedLanguage,
        notes,
        createdBy: clerkUserId,
      };
    }

    return {
      error: "request must include either image_hash (64-char sha256 hex) or image_base64",
      status: 400,
    };
  } catch {
    return { error: "request body must be JSON or multipart/form-data", status: 400 };
  }
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const clerkUserId = auth.ctx.kind === "admin" && "userId" in auth.ctx
    ? String((auth.ctx as { userId?: unknown }).userId ?? "")
    : "";

  const parsed = await parseInput(req, clerkUserId || "admin");
  if ("error" in parsed) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: parsed.status });
  }

  const supabase = dbAdmin();

  // Validate the slug exists so typos fail fast instead of landing
  // as orphan rows in the eval corpus.
  const slugCheck = await supabase
    .from("canonical_cards")
    .select("slug")
    .eq("slug", parsed.canonicalSlug)
    .maybeSingle();
  if (slugCheck.error) {
    return NextResponse.json(
      { ok: false, error: `slug lookup failed: ${slugCheck.error.message}` },
      { status: 500 },
    );
  }
  if (!slugCheck.data) {
    return NextResponse.json(
      { ok: false, error: `canonical_cards.slug = ${parsed.canonicalSlug} not found` },
      { status: 404 },
    );
  }

  let imageHash: string;
  let bytesSize: number;
  let wasUpload: boolean;

  if (parsed.imageBytes) {
    // Fresh photo — compute hash + upload to scan-eval/<hash>.jpg.
    imageHash = crypto.createHash("sha256").update(parsed.imageBytes).digest("hex");
    bytesSize = parsed.imageBytes.length;
    const evalKey = `${SCAN_EVAL_PREFIX}/${imageHash}.jpg`;
    const { error: uploadErr } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(evalKey, parsed.imageBytes, {
        upsert: true,
        contentType: "image/jpeg",
        cacheControl: "31536000, immutable",
      });
    if (uploadErr) {
      return NextResponse.json(
        { ok: false, error: `eval upload failed: ${uploadErr.message}` },
        { status: 500 },
      );
    }
    wasUpload = true;
  } else if (parsed.imageHash) {
    // Known-hash path — copy the existing scan-uploads object into
    // the eval prefix. If that object doesn't exist (scan-uploads was
    // swept) we fall back to asking the caller to upload bytes.
    imageHash = parsed.imageHash;
    const uploadKey = `${SCAN_UPLOADS_PREFIX}/${imageHash}.jpg`;
    const evalKey = `${SCAN_EVAL_PREFIX}/${imageHash}.jpg`;

    const { data: existingFile, error: downloadErr } = await supabase.storage
      .from(IMAGE_BUCKET)
      .download(uploadKey);
    if (downloadErr || !existingFile) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `source image not found at ${uploadKey} — scan-uploads may have been cleaned up; re-upload the bytes via multipart instead`,
        },
        { status: 404 },
      );
    }
    const sourceBytes = Buffer.from(await existingFile.arrayBuffer());
    bytesSize = sourceBytes.length;

    const { error: uploadErr } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(evalKey, sourceBytes, {
        upsert: true,
        contentType: "image/jpeg",
        cacheControl: "31536000, immutable",
      });
    if (uploadErr) {
      return NextResponse.json(
        { ok: false, error: `eval copy failed: ${uploadErr.message}` },
        { status: 500 },
      );
    }
    wasUpload = false;
  } else {
    return NextResponse.json(
      { ok: false, error: "either image_hash or multipart image is required" },
      { status: 400 },
    );
  }

  const storagePath = `${SCAN_EVAL_PREFIX}/${imageHash}.jpg`;

  const upsert = await supabase
    .from("scan_eval_images")
    .upsert(
      {
        canonical_slug: parsed.canonicalSlug,
        image_storage_path: storagePath,
        image_hash: imageHash,
        image_bytes_size: bytesSize,
        captured_source: parsed.capturedSource,
        captured_language: parsed.capturedLanguage,
        notes: parsed.notes,
        created_by: parsed.createdBy,
      },
      { onConflict: "image_storage_path" },
    )
    .select("id")
    .maybeSingle();

  if (upsert.error) {
    return NextResponse.json(
      { ok: false, error: `scan_eval_images upsert failed: ${upsert.error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    eval_image_id: upsert.data?.id,
    storage_path: storagePath,
    image_hash: imageHash,
    image_bytes_size: bytesSize,
    was_upload: wasUpload,
    canonical_slug: parsed.canonicalSlug,
  });
}
