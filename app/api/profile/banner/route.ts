import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { ensureAppUser, updateAppProfile } from "@/lib/data/app-user";

export const runtime = "nodejs";

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
    return NextResponse.json({ ok: false, error: "Invalid banner image." }, { status: 400 });
  }
  if (dataUrl.length > 4_500_000) {
    return NextResponse.json({ ok: false, error: "Banner image is too large." }, { status: 400 });
  }

  try {
    await ensureAppUser(auth.userId);
    const updated = await updateAppProfile(auth.userId, { profileBannerUrl: dataUrl });
    return NextResponse.json({ ok: true, bannerUrl: updated?.profile_banner_url ?? dataUrl });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
