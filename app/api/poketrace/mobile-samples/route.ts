import { NextResponse } from "next/server";
import { loadPokeTraceMobileSamples } from "@/lib/backfill/poketrace-ui";

export const runtime = "nodejs";

export async function GET() {
  try {
    const cards = await loadPokeTraceMobileSamples(6);
    return NextResponse.json({
      ok: true,
      cards,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
