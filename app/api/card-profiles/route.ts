import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { loadCardProfileDetail } from "@/lib/card-profiles";
import { hasPro } from "@/lib/entitlements";

export const runtime = "nodejs";

function sanitizeSlug(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function GET(req: Request) {
  const slug = sanitizeSlug(new URL(req.url).searchParams.get("slug"));
  if (!slug) {
    return NextResponse.json({ ok: false, error: "Missing slug query param." }, { status: 400 });
  }

  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  if (!(await hasPro(auth.userId))) {
    return NextResponse.json(
      { ok: false, error: "Pro subscription required." },
      { status: 403 },
    );
  }

  try {
    return NextResponse.json({
      ok: true,
      slug,
      profile: await loadCardProfileDetail(slug),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, slug, error: toErrorMessage(error) }, { status: 500 });
  }
}
