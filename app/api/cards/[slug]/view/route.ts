import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const canonicalSlug = typeof slug === "string" ? slug.trim() : "";

  if (!canonicalSlug) {
    return NextResponse.json({ ok: false, error: "Missing card slug." }, { status: 400 });
  }

  try {
    const supabase = dbPublic();
    const { error } = await supabase.rpc("record_card_page_view", {
      p_canonical_slug: canonicalSlug,
    });

    if (error) {
      const status = error.code === "23503" ? 404 : 500;
      return NextResponse.json({ ok: false, error: error.message }, { status });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
