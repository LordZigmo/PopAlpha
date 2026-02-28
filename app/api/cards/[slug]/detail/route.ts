import { NextResponse } from "next/server";
import { buildCardDetailResponse } from "@/lib/cards/detail";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  const data = await buildCardDetailResponse(slug);

  if (!data) {
    return NextResponse.json({ ok: false, error: "Card not found." }, { status: 404 });
  }

  return NextResponse.json(data);
}
