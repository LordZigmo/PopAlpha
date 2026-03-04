import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runPokemonTcgNormalizedMatch } from "@/lib/backfill/pokemontcg-normalized-match";

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
  const observations = url.searchParams.get("observations");
  const providerSetId = url.searchParams.get("set");
  const observationId = url.searchParams.get("observationId");
  const force = url.searchParams.get("force") === "1";

  const result = await runPokemonTcgNormalizedMatch({
    observationLimit: parseOptionalInt(observations),
    providerSetId: providerSetId?.trim() || undefined,
    observationId: observationId?.trim() || undefined,
    force,
  });

  const status = result.ok ? 200 : 500;
  return NextResponse.json(result, { status });
}
