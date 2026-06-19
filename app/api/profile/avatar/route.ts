import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { ensureAppUser, updateAppProfile } from "@/lib/data/app-user";

export const runtime = "nodejs";

// User-gated avatar upload. Mirrors POST /api/profile/banner: the client posts
// a base64 data URL, which is stored in app_users.profile_image_url. The user
// can only write their own row (RLS), and updateAppProfile goes through the
// per-user Supabase client.
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
  if (dataUrl.length > 4_500_000) {
    return NextResponse.json({ ok: false, error: "Avatar image is too large." }, { status: 400 });
  }

  try {
    await ensureAppUser(auth.userId);
    const updated = await updateAppProfile(auth.userId, { profileImageUrl: dataUrl });
    return NextResponse.json({ ok: true, imageUrl: updated?.profile_image_url ?? dataUrl });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
