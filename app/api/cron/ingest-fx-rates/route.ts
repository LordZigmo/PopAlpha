import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runFxRatesIngest } from "@/lib/backfill/fx-rates-ingest";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const result = await runFxRatesIngest({
    daysBack: parseOptionalInt(url.searchParams.get("days")),
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
