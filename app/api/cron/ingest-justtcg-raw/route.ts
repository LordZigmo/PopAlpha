import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runJustTcgRawIngest } from "@/lib/backfill/justtcg-raw-ingest";

export const runtime = "nodejs";
export const maxDuration = 300;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const setLimit = url.searchParams.get("sets");
  const providerSetId = url.searchParams.get("set");
  const pageLimitPerSet = url.searchParams.get("pages");
  const maxRequests = url.searchParams.get("maxRequests");

  const result = await runJustTcgRawIngest({
    setLimit: parseOptionalInt(setLimit),
    providerSetId: providerSetId?.trim() || undefined,
    pageLimitPerSet: parseOptionalInt(pageLimitPerSet),
    maxRequests: parseOptionalInt(maxRequests),
  });

  const status = result.ok ? 200 : 500;
  return NextResponse.json(result, { status });
}
