import { runScrydexRawIngest } from "@/lib/backfill/pokemontcg-raw-ingest";
import { runScrydexRawNormalize } from "@/lib/backfill/pokemontcg-raw-normalize";
import { runScrydexNormalizedMatch } from "@/lib/backfill/pokemontcg-normalized-match";
import { runProviderObservationTimeseries } from "@/lib/backfill/provider-observation-timeseries";
import { runProviderObservationVariantMetrics } from "@/lib/backfill/provider-observation-variant-metrics";
import { queuePendingRollups, getPendingRollupsCount } from "@/lib/backfill/provider-pipeline-rollup-queue";
import {
  buildProviderIngestionDisabledPayload,
  providerIngestionEnabled,
  providerSupportsAnalytics,
  type AnalyticsPipelineProvider,
  type BackendPipelineProvider,
} from "@/lib/backfill/provider-registry";

type PipelineStep<T extends object> = {
  name: string;
  ok: boolean;
  result: T;
};

type PipelineResult = {
  ok: boolean;
  provider: BackendPipelineProvider;
  startedAt: string;
  endedAt: string;
  firstError: string | null;
  retired?: boolean;
  preservedDataAvailable?: boolean;
  reason?: string;
  steps: PipelineStep<object>[];
};

type TouchedVariantKey = {
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  grade: string;
};

const MAX_STAGE_DRAIN_PASSES = process.env.PROVIDER_PIPELINE_STAGE_MAX_PASSES
  ? Math.max(1, parseInt(process.env.PROVIDER_PIPELINE_STAGE_MAX_PASSES, 10))
  : 8;
const PIPELINE_DRAIN_RESERVE_MS = process.env.PROVIDER_PIPELINE_DRAIN_RESERVE_MS
  ? Math.max(0, parseInt(process.env.PROVIDER_PIPELINE_DRAIN_RESERVE_MS, 10))
  : 15000;

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mergeTouchedVariantKeys(
  ...groups: Array<Array<{
    canonical_slug?: string | null;
    variant_ref?: string | null;
    provider?: string | null;
    grade?: string | null;
  }> | null | undefined>
): Array<{
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  grade: string;
}> {
  const deduped = new Map<string, {
    canonical_slug: string;
    variant_ref: string;
    provider: string;
    grade: string;
  }>();

  for (const group of groups) {
    for (const raw of group ?? []) {
      const canonicalSlug = String(raw?.canonical_slug ?? "").trim();
      const variantRef = String(raw?.variant_ref ?? "").trim();
      const provider = String(raw?.provider ?? "").trim().toUpperCase();
      const grade = String(raw?.grade ?? "RAW").trim().toUpperCase() || "RAW";
      if (!canonicalSlug || !variantRef || !provider || !grade) continue;
      deduped.set(
        `${canonicalSlug}::${variantRef}::${provider}::${grade}`,
        {
          canonical_slug: canonicalSlug,
          variant_ref: variantRef,
          provider,
          grade,
        },
      );
    }
  }

  return [...deduped.values()];
}

function hasIngestProgress(result: object): boolean {
  const row = result as Record<string, unknown>;
  return (
    numberFromUnknown(row.rawPayloadsInserted) > 0
    || numberFromUnknown(row.items_upserted) > 0
    || numberFromUnknown(row.cardsFetched) > 0
    || numberFromUnknown(row.items_fetched) > 0
  );
}

function hasPipelineTimeRemaining(deadlineMs: number | null | undefined): boolean {
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs)) return true;
  return (deadlineMs - Date.now()) > PIPELINE_DRAIN_RESERVE_MS;
}

function runtimeBudgetFromDeadline(deadlineMs: number | null | undefined): number | undefined {
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs)) return undefined;
  return Math.max(1000, deadlineMs - Date.now());
}

function resolveSingleProviderSetId(
  requestedProviderSetId: string | null | undefined,
  ingestResult: object,
): string | undefined {
  const requested = String(requestedProviderSetId ?? "").trim();
  if (requested) return requested;

  const rawSelectedProviderSetIds = (ingestResult as { selectedProviderSetIds?: unknown[] }).selectedProviderSetIds;
  const selectedProviderSetIds = Array.isArray(rawSelectedProviderSetIds)
    ? rawSelectedProviderSetIds
      .map((value) => String(value ?? "").trim())
      .filter((value) => value.length > 0)
    : [];
  const uniqueProviderSetIds = [...new Set(selectedProviderSetIds)];
  if (uniqueProviderSetIds.length === 1) return uniqueProviderSetIds[0];
  return undefined;
}

async function drainPipelineStage<T extends {
  ok: boolean;
  firstError?: string | null;
}>(opts: {
  name: string;
  steps: PipelineStep<object>[];
  run: () => Promise<T>;
  errorMessage: string;
  requestedField: string;
  processedField: string;
  deadlineMs?: number | null;
  extractTouchedVariantKeys?: (result: T) => TouchedVariantKey[];
}): Promise<{
  firstError: string | null;
  touchedVariantKeys: TouchedVariantKey[];
}> {
  let touchedVariantKeys: TouchedVariantKey[] = [];

  for (let pass = 0; pass < MAX_STAGE_DRAIN_PASSES; pass += 1) {
    if (pass > 0 && !hasPipelineTimeRemaining(opts.deadlineMs)) break;

    const result = await opts.run();
    opts.steps.push({ name: opts.name, ok: result.ok, result });
    if (!result.ok) {
      return {
        firstError: result.firstError ?? opts.errorMessage,
        touchedVariantKeys,
      };
    }

    if (opts.extractTouchedVariantKeys) {
      touchedVariantKeys = mergeTouchedVariantKeys(
        touchedVariantKeys,
        opts.extractTouchedVariantKeys(result),
      );
    }

    const requested = numberFromUnknown((result as Record<string, unknown>)[opts.requestedField]);
    const processed = numberFromUnknown((result as Record<string, unknown>)[opts.processedField]);
    if (requested <= 0 || processed <= 0 || processed < requested) break;
  }

  return {
    firstError: null,
    touchedVariantKeys,
  };
}

type PipelineOptions = {
  providerSetId?: string | null;
  setLimit?: number;
  pageLimitPerSet?: number;
  maxRequests?: number;
  payloadLimit?: number;
  matchObservations?: number;
  timeseriesObservations?: number;
  metricsObservations?: number;
  force?: boolean;
  retryOnly?: boolean;
  matchScanDirection?: "newest" | "oldest";
  matchMode?: "incremental" | "backlog";
  deadlineMs?: number | null;
};

type PipelineStageResult = {
  ok: boolean;
  firstError?: string | null;
};

type ProviderPipelineHandlers = {
  provider: BackendPipelineProvider;
  ingestErrorMessage: string;
  normalizeErrorMessage: string;
  matchErrorMessage: string;
  timeseriesErrorMessage?: string;
  variantMetricsErrorMessage?: string;
  analyticsProvider?: AnalyticsPipelineProvider;
  runIngest: (opts: PipelineOptions) => Promise<PipelineStageResult & object>;
  runNormalize: (opts: PipelineOptions, effectiveProviderSetId: string | undefined) => Promise<PipelineStageResult & object>;
  runMatch: (opts: PipelineOptions, effectiveProviderSetId: string | undefined) => Promise<PipelineStageResult & object>;
};

const PROVIDER_PIPELINE_HANDLERS: Record<BackendPipelineProvider, ProviderPipelineHandlers> = {
  SCRYDEX: {
    provider: "SCRYDEX",
    ingestErrorMessage: "scrydex ingest failed",
    normalizeErrorMessage: "scrydex normalize failed",
    matchErrorMessage: "scrydex match failed",
    timeseriesErrorMessage: "scrydex timeseries failed",
    variantMetricsErrorMessage: "scrydex variant metrics failed",
    analyticsProvider: "SCRYDEX",
    runIngest: (opts) => runScrydexRawIngest({
      providerSetId: opts.providerSetId ?? undefined,
      setLimit: opts.setLimit,
      pageLimitPerSet: opts.pageLimitPerSet,
      maxRequests: opts.maxRequests,
      force: opts.force === true,
    }),
    runNormalize: (opts, effectiveProviderSetId) => runScrydexRawNormalize({
      providerSetId: effectiveProviderSetId,
      payloadLimit: opts.payloadLimit,
      force: opts.force === true,
    }),
    runMatch: (opts, effectiveProviderSetId) => runScrydexNormalizedMatch({
      providerSetId: effectiveProviderSetId,
      observationLimit: opts.matchObservations,
      force: opts.force === true,
      scanDirection: opts.matchScanDirection ?? "newest",
      mode: opts.matchMode ?? "incremental",
      maxRuntimeMs: runtimeBudgetFromDeadline(opts.deadlineMs),
    }),
  },
};

async function runProviderPipeline(provider: BackendPipelineProvider, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const handlers = PROVIDER_PIPELINE_HANDLERS[provider];
  const startedAt = new Date().toISOString();
  if (!providerIngestionEnabled(provider)) {
    return {
      ...buildProviderIngestionDisabledPayload(provider),
      startedAt,
      endedAt: new Date().toISOString(),
      firstError: null,
      steps: [],
    };
  }
  const steps: PipelineStep<object>[] = [];
  let firstError: string | null = null;
  let timeseriesTouchedKeys: TouchedVariantKey[] = [];
  let variantMetricsTouchedKeys: TouchedVariantKey[] = [];

  const ingest = await handlers.runIngest(opts);
  steps.push({ name: "ingest", ok: ingest.ok, result: ingest });
  if (!ingest.ok && !hasIngestProgress(ingest)) {
    firstError = ingest.firstError ?? handlers.ingestErrorMessage;
  }
  const effectiveProviderSetId = resolveSingleProviderSetId(opts.providerSetId, ingest);

  if (!firstError) {
    const normalize = await drainPipelineStage({
      name: "normalize",
      steps,
      run: () => handlers.runNormalize(opts, effectiveProviderSetId) as Promise<{
        ok: boolean;
        firstError?: string | null;
      }>,
      errorMessage: handlers.normalizeErrorMessage,
      requestedField: "payloadsRequested",
      processedField: "payloadsProcessed",
      deadlineMs: opts.deadlineMs,
    });
    if (normalize.firstError) firstError = normalize.firstError;
  }

  if (!firstError) {
    const match = await drainPipelineStage({
      name: "match",
      steps,
      run: () => handlers.runMatch(opts, effectiveProviderSetId) as Promise<{
        ok: boolean;
        firstError?: string | null;
      }>,
      errorMessage: handlers.matchErrorMessage,
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
    });
    if (match.firstError) firstError = match.firstError;
  }

  if (!firstError && providerSupportsAnalytics(provider)) {
    const timeseries = await drainPipelineStage({
      name: "timeseries",
      steps,
      run: () => runProviderObservationTimeseries({
        provider,
        providerSetId: effectiveProviderSetId,
        observationLimit: opts.timeseriesObservations ?? opts.matchObservations,
        force: opts.force === true,
      }),
      errorMessage: handlers.timeseriesErrorMessage ?? `${provider.toLowerCase()} timeseries failed`,
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
      extractTouchedVariantKeys: (result) => result.touchedVariantKeys,
    });
    if (timeseries.firstError) firstError = timeseries.firstError;
    timeseriesTouchedKeys = timeseries.touchedVariantKeys;
  }

  if (!firstError && providerSupportsAnalytics(provider)) {
    const variantMetrics = await drainPipelineStage({
      name: "variant_metrics",
      steps,
      run: () => runProviderObservationVariantMetrics({
        provider,
        providerSetId: effectiveProviderSetId,
        observationLimit: opts.metricsObservations ?? opts.timeseriesObservations ?? opts.matchObservations,
        force: opts.force === true,
      }),
      errorMessage: handlers.variantMetricsErrorMessage ?? `${provider.toLowerCase()} variant metrics failed`,
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
      extractTouchedVariantKeys: (result) => result.touchedVariantKeys,
    });
    if (variantMetrics.firstError) firstError = variantMetrics.firstError;
    variantMetricsTouchedKeys = variantMetrics.touchedVariantKeys;
  }

  // Always queue rollups from timeseries touched keys, even if variant_metrics
  // failed. A variant_metrics constraint violation should not block the rollup
  // of pricing data that timeseries already wrote to price_snapshots.
  if (providerSupportsAnalytics(provider)) {
    const rollupKeys = mergeTouchedVariantKeys(
      timeseriesTouchedKeys,
      variantMetricsTouchedKeys,
    );
    if (rollupKeys.length > 0) {
      try {
        const pendingCount = await getPendingRollupsCount();
        if (pendingCount > 5000) {
          steps.push({
            name: "targeted_rollups",
            ok: true,
            result: {
              mode: "skipped",
              reason: "queue_cap_exceeded",
              pendingCount,
              cap: 5000,
              variantMetricsError: firstError ?? null,
            },
          });
        } else {
        const queued = await queuePendingRollups(rollupKeys);
        steps.push({
          name: "targeted_rollups",
          ok: true,
          result: {
            mode: "deferred",
            queued: queued.queued,
            deferredTo: "hourly_batch",
            variantMetricsError: firstError ?? null,
          },
        });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!firstError) firstError = message;
        steps.push({
          name: "targeted_rollups",
          ok: false,
          result: { mode: "deferred", error: message },
        });
      }
    } else {
      steps.push({
        name: "targeted_rollups",
        ok: true,
        result: { mode: "deferred", queued: 0 },
      });
    }
  }

  const endedAt = new Date().toISOString();
  const coreOk = !firstError;
  return {
    ok: coreOk,
    provider,
    startedAt,
    endedAt,
    firstError,
    steps,
  };
}

export async function runScrydexPipeline(opts: {
  providerSetId?: string | null;
  setLimit?: number;
  pageLimitPerSet?: number;
  maxRequests?: number;
  payloadLimit?: number;
  matchObservations?: number;
  timeseriesObservations?: number;
  metricsObservations?: number;
  force?: boolean;
  matchScanDirection?: "newest" | "oldest";
  matchMode?: "incremental" | "backlog";
  deadlineMs?: number | null;
} = {}): Promise<PipelineResult> {
  return runProviderPipeline("SCRYDEX", opts);
}
