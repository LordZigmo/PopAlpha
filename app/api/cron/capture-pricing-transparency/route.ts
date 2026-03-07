import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { capturePricingTransparencySnapshot } from "@/lib/backfill/pricing-transparency-capture";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  try {
    const result = await capturePricingTransparencySnapshot();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

