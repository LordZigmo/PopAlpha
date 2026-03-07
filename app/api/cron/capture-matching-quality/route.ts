import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { captureMatchingQualityAudit } from "@/lib/backfill/matching-quality-audit";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const windowHoursRaw = Number.parseInt(url.searchParams.get("windowHours") ?? "24", 10);
    const windowHours = Number.isFinite(windowHoursRaw) ? Math.max(1, windowHoursRaw) : 24;
    const result = await captureMatchingQualityAudit(windowHours);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

