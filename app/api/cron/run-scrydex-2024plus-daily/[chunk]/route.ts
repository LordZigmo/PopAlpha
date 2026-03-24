import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { enqueuePipelineJob } from "@/lib/backfill/provider-pipeline-job-queue";
import {
  getScrydex2024PlusTarget,
  getScrydex2024PlusDailyChunk,
  SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT,
} from "@/lib/backfill/scrydex-2024plus-targets";
import { loadScrydexSetFootprints } from "@/lib/backfill/scrydex-price-history";
import { dbAdmin } from "@/lib/db/admin";
import { getProviderCooldownState } from "@/lib/backfill/provider-cooldown";

export const runtime = "nodejs";
export const maxDuration = 300;

function parseChunkParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT) {
    throw new Error(`chunk must be between 1 and ${SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT}`);
  }
  return parsed;
}

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function seedMissingScrydexMappings(providerSetIds: string[]): Promise<number> {
  const supabase = dbAdmin();
  const targetRows = providerSetIds
    .map((providerSetId) => getScrydex2024PlusTarget(providerSetId))
    .filter((target): target is NonNullable<ReturnType<typeof getScrydex2024PlusTarget>> => Boolean(target));

  if (targetRows.length === 0) return 0;

  const { data, error } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code")
    .eq("provider", "SCRYDEX")
    .in("canonical_set_code", targetRows.map((target) => target.setCode));
  if (error) throw new Error(`provider_set_map(scrydex daily seed load): ${error.message}`);

  const existingCodes = new Set(
    (data ?? [])
      .map((row) => String((row as { canonical_set_code: string | null }).canonical_set_code ?? "").trim())
      .filter(Boolean),
  );
  const missingRows = targetRows
    .filter((target) => !existingCodes.has(target.setCode))
    .map((target) => ({
      provider: "SCRYDEX",
      canonical_set_code: target.setCode,
      canonical_set_name: target.setName,
      provider_set_id: target.providerSetId,
      confidence: 1,
    }));

  if (missingRows.length === 0) return 0;

  const { error: upsertError } = await supabase
    .from("provider_set_map")
    .upsert(missingRows, { onConflict: "provider,canonical_set_code" });
  if (upsertError) throw new Error(`provider_set_map(scrydex daily seed upsert): ${upsertError.message}`);
  return missingRows.length;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ chunk: string }> },
) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  try {
    const { chunk } = await context.params;
    const chunkNumber = parseChunkParam(chunk);
    const url = new URL(req.url);
    const matchObservations = parseOptionalInt(url.searchParams.get("observations")) ?? 500;
    const timeseriesObservations = parseOptionalInt(url.searchParams.get("timeseriesObservations")) ?? matchObservations;
    const metricsObservations = parseOptionalInt(url.searchParams.get("metricsObservations")) ?? timeseriesObservations;
    const force = url.searchParams.get("force") === "1";
    const providerCooldown = await getProviderCooldownState("SCRYDEX");
    if (providerCooldown.active && !force) {
      return NextResponse.json({
        ok: true,
        mode: "blocked",
        chunk: chunkNumber,
        chunkCount: SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT,
        reason: "provider_cooldown_active",
        cooldownUntil: providerCooldown.cooldownUntil,
        providerSetIds: getScrydex2024PlusDailyChunk(chunkNumber),
        plannedRequests: 0,
        queuedJobs: 0,
        seededMappings: 0,
        runs: [],
      });
    }

    const providerSetIds = getScrydex2024PlusDailyChunk(chunkNumber);
    const seededMappings = await seedMissingScrydexMappings(providerSetIds);
    const footprints = await loadScrydexSetFootprints({ providerSetIds });
    const footprintBySet = new Map(footprints.map((footprint) => [footprint.providerSetId, footprint] as const));

    const runs = [];
    let ok = true;
    let plannedRequests = 0;
    let queuedJobs = 0;

    for (const providerSetId of providerSetIds) {
      const footprint = footprintBySet.get(providerSetId);
      const target = getScrydex2024PlusTarget(providerSetId);
      if (!target) {
        ok = false;
        runs.push({ providerSetId, ok: false, firstError: "SCRYDEX_2024_PLUS_TARGET_UNKNOWN" });
        continue;
      }

      const dailyCaptureRequests = footprint?.dailyCaptureRequests ?? 1;
      plannedRequests += dailyCaptureRequests;
      const queued = await enqueuePipelineJob({
        provider: "SCRYDEX",
        jobKind: "PIPELINE",
        params: {
          providerSetId,
          setLimit: 1,
          pageLimitPerSet: dailyCaptureRequests,
          maxRequests: dailyCaptureRequests,
          payloadLimit: dailyCaptureRequests,
          matchObservations,
          timeseriesObservations,
          metricsObservations,
          force,
        },
        priority: 130,
      });
      if (queued.enqueued) queuedJobs += 1;
      ok = ok && (queued.enqueued || queued.reason.startsWith("existing_") || queued.reason === "provider_cooldown_active");
      runs.push({
        providerSetId,
        setCode: footprint?.setCode ?? target.setCode,
        setName: footprint?.setName ?? target.setName,
        expectedCardCount: footprint?.expectedCardCount ?? 0,
        providerCardCount: footprint?.providerCardCount ?? 0,
        matchedCardCount: footprint?.matchedCardCount ?? 0,
        dailyCaptureRequests,
        seededMapping: seededMappings > 0 && (footprint?.providerCardCount ?? 0) === 0,
        fallbackCapture: (footprint?.matchedCardCount ?? 0) < (footprint?.expectedCardCount ?? 0),
        enqueued: queued.enqueued,
        jobId: queued.jobId,
        reason: queued.reason,
      });
    }

    return NextResponse.json({
      ok,
      mode: "queued",
      chunk: chunkNumber,
      chunkCount: SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT,
      providerSetIds,
      plannedRequests,
      queuedJobs,
      seededMappings,
      runs,
    }, { status: ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
