import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runJustTcgRawNormalize } from "@/lib/backfill/justtcg-raw-normalize";
import { buildProviderIngestionDisabledPayload, providerIngestionEnabled } from "@/lib/backfill/provider-registry";

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
  if (!providerIngestionEnabled("JUSTTCG")) {
    return NextResponse.json(buildProviderIngestionDisabledPayload("JUSTTCG"));
  }

  const url = new URL(req.url);
  const payloadLimit = url.searchParams.get("payloads");
  const providerSetId = url.searchParams.get("set");
  const rawPayloadId = url.searchParams.get("rawId");
  const force = url.searchParams.get("force") === "1";

  const result = await runJustTcgRawNormalize({
    payloadLimit: parseOptionalInt(payloadLimit),
    providerSetId: providerSetId?.trim() || undefined,
    rawPayloadId: rawPayloadId?.trim() || undefined,
    force,
  });

  const status = result.ok ? 200 : 500;
  return NextResponse.json(result, { status });
}
