import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runPokemonTcgPipeline } from "@/lib/backfill/provider-pipeline-orchestrator";

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

  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";

    const result = await runPokemonTcgPipeline({
      setLimit: parseOptionalInt(url.searchParams.get("sets")) ?? 12,
      pageLimitPerSet: parseOptionalInt(url.searchParams.get("pages")),
      maxRequests: parseOptionalInt(url.searchParams.get("maxRequests")),
      payloadLimit: parseOptionalInt(url.searchParams.get("payloads")),
      matchObservations: parseOptionalInt(url.searchParams.get("observations")),
      timeseriesObservations: parseOptionalInt(url.searchParams.get("timeseriesObservations")),
      force,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
