import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import {
  runProviderObservationTimeseries,
  type SupportedProvider,
} from "@/lib/backfill/provider-observation-timeseries";

export const runtime = "nodejs";
export const maxDuration = 300;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseProviders(raw: string | null): SupportedProvider[] {
  const value = String(raw ?? "all").trim().toUpperCase();
  if (value === "ALL") return ["JUSTTCG", "POKEMON_TCG_API"];
  if (value === "JUSTTCG") return ["JUSTTCG"];
  if (value === "POKEMON_TCG_API" || value === "POKEMONTCG") return ["POKEMON_TCG_API"];
  return ["JUSTTCG", "POKEMON_TCG_API"];
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const providers = parseProviders(url.searchParams.get("provider"));
  const observations = parseOptionalInt(url.searchParams.get("observations"));
  const providerSetId = url.searchParams.get("set")?.trim() || undefined;
  const observationId = url.searchParams.get("observationId")?.trim() || undefined;
  const force = url.searchParams.get("force") === "1";

  const results = [];
  for (const provider of providers) {
    const result = await runProviderObservationTimeseries({
      provider,
      observationLimit: observations,
      providerSetId,
      observationId,
      force,
    });
    results.push(result);
  }

  const ok = results.every((result) => result.ok);
  return NextResponse.json({ ok, results }, { status: ok ? 200 : 500 });
}
