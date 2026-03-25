import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runScrydexPipeline } from "@/lib/backfill/provider-pipeline-orchestrator";
import {
  backfillScrydexPriceHistoryForSet,
  planScrydexHistoricalBackfillSets,
} from "@/lib/backfill/scrydex-price-history";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_BACKFILL_SET_LIMIT = 24;
const DEFAULT_BACKFILL_MAX_CREDITS = 10000;

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
    const providerSetId = url.searchParams.get("set")?.trim() || null;
    const hotSetLimit = Math.max(
      1,
      Math.min(parseOptionalInt(url.searchParams.get("sets")) ?? DEFAULT_BACKFILL_SET_LIMIT, 48),
    );
    const days = Math.max(1, Math.min(parseOptionalInt(url.searchParams.get("days")) ?? 90, 180));
    const maxCredits = Math.max(1, parseOptionalInt(url.searchParams.get("maxCredits")) ?? DEFAULT_BACKFILL_MAX_CREDITS);
    const maxCards = parseOptionalInt(url.searchParams.get("maxCards"));
    const captureToday = url.searchParams.get("captureToday") !== "0";
    const dryRun = url.searchParams.get("dryRun") === "1";
    const missingOnly = url.searchParams.get("missingOnly") === "1";
    const payloadLimit = parseOptionalInt(url.searchParams.get("payloads"));
    const matchObservations = parseOptionalInt(url.searchParams.get("observations")) ?? 1000;
    const timeseriesObservations = parseOptionalInt(url.searchParams.get("timeseriesObservations")) ?? matchObservations;
    const metricsObservations = parseOptionalInt(url.searchParams.get("metricsObservations")) ?? timeseriesObservations;

    const plan = await planScrydexHistoricalBackfillSets({
      providerSetIds: providerSetId ? [providerSetId] : [],
      maxCredits,
      hotSetLimit,
    });

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        mode: "plan",
        captureToday,
        days,
        maxCards: maxCards ?? null,
        missingOnly,
        plan,
      });
    }

    const runs = [];
    let ok = true;

    for (const selectedSet of plan.selectedSets) {
      const capture = captureToday
        ? await runScrydexPipeline({
          providerSetId: selectedSet.providerSetId,
          setLimit: 1,
          pageLimitPerSet: selectedSet.dailyCaptureRequests,
          maxRequests: selectedSet.dailyCaptureRequests,
          payloadLimit: payloadLimit ?? selectedSet.dailyCaptureRequests,
          matchObservations,
          timeseriesObservations,
          metricsObservations,
          matchMode: "incremental",
        })
        : null;

      const history = await backfillScrydexPriceHistoryForSet({
        providerSetId: selectedSet.providerSetId,
        days,
        maxCards,
        onlyMissingRecentHistory: missingOnly,
      });

      ok = ok && (capture?.ok ?? true) && history.ok;
      runs.push({
        providerSetId: selectedSet.providerSetId,
        setCode: selectedSet.setCode,
        setName: selectedSet.setName,
        dailyCaptureRequests: selectedSet.dailyCaptureRequests,
        historyBackfillCredits: selectedSet.historyBackfillCredits,
        priorityReasons: selectedSet.priorityReasons,
        capture,
        history,
      });
    }

    return NextResponse.json({
      ok,
      mode: "execute",
      captureToday,
      days,
      maxCards: maxCards ?? null,
      missingOnly,
      estimatedCredits: plan.estimatedCredits,
      selectedSetCount: plan.selectedSets.length,
      skippedSetCount: plan.skippedSets.length,
      plan,
      runs,
    }, { status: ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
