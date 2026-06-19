import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { ensureAppUser, updateAppProfile } from "@/lib/data/app-user";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";

const IMAGE_BUCKET = "card-images";
// Vercel Functions cap request bodies at 4.5 MB. The avatar arrives as a
// base64 data URL, so reject anything that would exceed that before we read it.
const MAX_REQUEST_BYTES = 4_500_000;

/** Decode a `data:image/<type>;base64,<...>` URL into bytes + content type. */
function decodeImageDataUrl(
  dataUrl: string,
): { bytes: Buffer; contentType: string; ext: string } | null {
  const match = /^data:(image\/(png|jpeg|jpg|webp|heic|heif));base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const rawType = match[1].toLowerCase();
  const contentType = rawType === "image/jpg" ? "image/jpeg" : rawType;
  const subtype = contentType.split("/")[1];
  const ext = subtype === "jpeg" ? "jpg" : subtype;
  const bytes = Buffer.from(match[3], "base64");
  if (bytes.length === 0) return null;
  return { bytes, contentType, ext };
}

// User-gated avatar upload. Stores the image in the public `card-images`
// bucket and persists ONLY a compact public URL in app_users.profile_image_url
// (NOT the base64 — that would blow past Vercel's 4.5 MB response cap on
// GET /api/profile and is unusable in activity feeds). Service-role (dbAdmin)
// is required for the Storage write; the storage key is derived from the
// authenticated user's id, so a user can only ever overwrite their own avatar.
// The DB write stays on the per-user (RLS) client via updateAppProfile.
export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
  if (!dataUrl.startsWith("data:image/")) {
    return NextResponse.json({ ok: false, error: "Invalid avatar image." }, { status: 400 });
  }
  if (dataUrl.length > MAX_REQUEST_BYTES) {
    return NextResponse.json({ ok: false, error: "Avatar image is too large." }, { status: 413 });
  }
  const decoded = decodeImageDataUrl(dataUrl);
  if (!decoded) {
    return NextResponse.json({ ok: false, error: "Unsupported avatar image format." }, { status: 400 });
  }

  try {
    await ensureAppUser(auth.userId);

    const supabase = dbAdmin();
    // Opaque, stable key per user (hash so the public URL never exposes the
    // Clerk user id). upsert overwrites the same object on re-upload.
    const keyHash = crypto.createHash("sha256").update(auth.userId).digest("hex").slice(0, 32);
    const storageKey = `avatars/${keyHash}.${decoded.ext}`;
    const upload = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(storageKey, decoded.bytes, {
        upsert: true,
        contentType: decoded.contentType,
        cacheControl: "no-cache",
      });
    if (upload.error) {
      throw new Error(`avatar storage upload failed: ${upload.error.message}`);
    }

    const publicUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(storageKey).data.publicUrl;
    // The key is stable (upsert), so version the stored URL to force clients
    // and the CDN to refetch the new image after a re-upload.
    const versionedUrl = `${publicUrl}?v=${Date.now()}`;

    const updated = await updateAppProfile(auth.userId, { profileImageUrl: versionedUrl });
    return NextResponse.json({ ok: true, imageUrl: updated?.profile_image_url ?? versionedUrl });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
