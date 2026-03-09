import { NextResponse } from "next/server";
import { loadPokeTraceCardPreview } from "@/lib/backfill/poketrace-ui";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    slug: string;
  }>;
};

export async function GET(req: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const canonicalSlug = slug?.trim();
    if (!canonicalSlug) {
      return NextResponse.json({ ok: false, error: "Missing card slug." }, { status: 400 });
    }

    const url = new URL(req.url);
    const printingId = url.searchParams.get("printing")?.trim() || null;
    const card = await loadPokeTraceCardPreview({
      canonicalSlug,
      printingId,
    });

    return NextResponse.json({
      ok: true,
      card,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
