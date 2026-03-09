import { runJustTcgRawIngest } from "@/lib/backfill/justtcg-raw-ingest";
import { runJustTcgRawNormalize } from "@/lib/backfill/justtcg-raw-normalize";
import { runJustTcgNormalizedMatch } from "@/lib/backfill/justtcg-normalized-match";
import { runScrydexRawIngest } from "@/lib/backfill/pokemontcg-raw-ingest";
import { runScrydexRawNormalize } from "@/lib/backfill/pokemontcg-raw-normalize";
import { runScrydexNormalizedMatch } from "@/lib/backfill/pokemontcg-normalized-match";
import { runProviderObservationTimeseries } from "@/lib/backfill/provider-observation-timeseries";
import { runProviderObservationVariantMetrics } from "@/lib/backfill/provider-observation-variant-metrics";
import { refreshPipelineRollupsForVariantKeys } from "@/lib/backfill/provider-pipeline-rollups";

type PipelineStep<T extends object> = {
  name: string;
  ok: boolean;
  result: T;
};

type PipelineResult = {
  ok: boolean;
  provider: "JUSTTCG" | "SCRYDEX";
  startedAt: string;
  endedAt: string;
  firstError: string | null;
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
  : 50;
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

export async function runJustTcgPipeline(opts: {
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
  deadlineMs?: number | null;
} = {}): Promise<PipelineResult> {
  const startedAt = new Date().toISOString();
  const steps: PipelineStep<object>[] = [];
  let firstError: string | null = null;
  let timeseriesTouchedKeys: TouchedVariantKey[] = [];
  let variantMetricsTouchedKeys: TouchedVariantKey[] = [];

  const ingest = await runJustTcgRawIngest({
    providerSetId: opts.providerSetId ?? undefined,
    setLimit: opts.setLimit,
    pageLimitPerSet: opts.pageLimitPerSet,
    maxRequests: opts.maxRequests,
    retryOnly: opts.retryOnly === true,
  });
  steps.push({ name: "ingest", ok: ingest.ok, result: ingest });
  if (!ingest.ok && !hasIngestProgress(ingest)) {
    firstError = ingest.firstError ?? "justtcg ingest failed";
  }

  if (!firstError) {
    const normalize = await drainPipelineStage({
      name: "normalize",
      steps,
      run: () => runJustTcgRawNormalize({
        providerSetId: opts.providerSetId ?? undefined,
        payloadLimit: opts.payloadLimit,
        force: opts.force === true,
      }),
      errorMessage: "justtcg normalize failed",
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
      run: () => runJustTcgNormalizedMatch({
        providerSetId: opts.providerSetId ?? undefined,
        observationLimit: opts.matchObservations,
        force: opts.force === true,
      }),
      errorMessage: "justtcg match failed",
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
    });
    if (match.firstError) firstError = match.firstError;
  }

  if (!firstError) {
    const timeseries = await drainPipelineStage({
      name: "timeseries",
      steps,
      run: () => runProviderObservationTimeseries({
        provider: "JUSTTCG",
        providerSetId: opts.providerSetId ?? undefined,
        observationLimit: opts.timeseriesObservations ?? opts.matchObservations,
        force: opts.force === true,
      }),
      errorMessage: "justtcg timeseries failed",
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
      extractTouchedVariantKeys: (result) => result.touchedVariantKeys,
    });
    if (timeseries.firstError) firstError = timeseries.firstError;
    timeseriesTouchedKeys = timeseries.touchedVariantKeys;
  }

  if (!firstError) {
    const variantMetrics = await drainPipelineStage({
      name: "variant_metrics",
      steps,
      run: () => runProviderObservationVariantMetrics({
        provider: "JUSTTCG",
        providerSetId: opts.providerSetId ?? undefined,
        observationLimit: opts.metricsObservations ?? opts.timeseriesObservations ?? opts.matchObservations,
        force: opts.force === true,
      }),
      errorMessage: "justtcg variant metrics failed",
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
      extractTouchedVariantKeys: (result) => result.touchedVariantKeys,
    });
    if (variantMetrics.firstError) firstError = variantMetrics.firstError;
    variantMetricsTouchedKeys = variantMetrics.touchedVariantKeys;

    if (!firstError) {
      const rollupKeys = mergeTouchedVariantKeys(
        timeseriesTouchedKeys,
        variantMetricsTouchedKeys,
      );
      const rollups = await refreshPipelineRollupsForVariantKeys({
        keys: rollupKeys,
      });
      steps.push({ name: "targeted_rollups", ok: rollups.ok, result: rollups });
      if (!rollups.ok) firstError = rollups.firstError ?? "justtcg targeted rollups failed";
    }
  }

  const endedAt = new Date().toISOString();
  const coreOk = !firstError;
  return {
    ok: coreOk,
    provider: "JUSTTCG",
    startedAt,
    endedAt,
    firstError,
    steps,
  };
}

export async function runPokemonTcgPipeline(opts: {
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
  const startedAt = new Date().toISOString();
  const steps: PipelineStep<object>[] = [];
  let firstError: string | null = null;
  let timeseriesTouchedKeys: TouchedVariantKey[] = [];
  let variantMetricsTouchedKeys: TouchedVariantKey[] = [];

  const ingest = await runScrydexRawIngest({
    providerSetId: opts.providerSetId ?? undefined,
    setLimit: opts.setLimit,
    pageLimitPerSet: opts.pageLimitPerSet,
    maxRequests: opts.maxRequests,
  });
  steps.push({ name: "ingest", ok: ingest.ok, result: ingest });
  if (!ingest.ok && !hasIngestProgress(ingest)) {
    firstError = ingest.firstError ?? "scrydex ingest failed";
  }

  if (!firstError) {
    const normalize = await drainPipelineStage({
      name: "normalize",
      steps,
      run: () => runScrydexRawNormalize({
        providerSetId: opts.providerSetId ?? undefined,
        payloadLimit: opts.payloadLimit,
        force: opts.force === true,
      }),
      errorMessage: "scrydex normalize failed",
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
      run: () => runScrydexNormalizedMatch({
        providerSetId: opts.providerSetId ?? undefined,
        observationLimit: opts.matchObservations,
        force: opts.force === true,
        scanDirection: opts.matchScanDirection ?? "newest",
        mode: opts.matchMode ?? "incremental",
        maxRuntimeMs: runtimeBudgetFromDeadline(opts.deadlineMs),
      }),
      errorMessage: "scrydex match failed",
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
    });
    if (match.firstError) firstError = match.firstError;
  }

  if (!firstError) {
    const timeseries = await drainPipelineStage({
      name: "timeseries",
      steps,
      run: () => runProviderObservationTimeseries({
        provider: "SCRYDEX",
        providerSetId: opts.providerSetId ?? undefined,
        observationLimit: opts.timeseriesObservations ?? opts.matchObservations,
        force: opts.force === true,
      }),
      errorMessage: "scrydex timeseries failed",
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
      extractTouchedVariantKeys: (result) => result.touchedVariantKeys,
    });
    if (timeseries.firstError) firstError = timeseries.firstError;
    timeseriesTouchedKeys = timeseries.touchedVariantKeys;
  }

  if (!firstError) {
    const variantMetrics = await drainPipelineStage({
      name: "variant_metrics",
      steps,
      run: () => runProviderObservationVariantMetrics({
        provider: "SCRYDEX",
        providerSetId: opts.providerSetId ?? undefined,
        observationLimit: opts.metricsObservations ?? opts.timeseriesObservations ?? opts.matchObservations,
        force: opts.force === true,
      }),
      errorMessage: "scrydex variant metrics failed",
      requestedField: "observationsRequested",
      processedField: "observationsProcessed",
      deadlineMs: opts.deadlineMs,
      extractTouchedVariantKeys: (result) => result.touchedVariantKeys,
    });
    if (variantMetrics.firstError) firstError = variantMetrics.firstError;
    variantMetricsTouchedKeys = variantMetrics.touchedVariantKeys;

    if (!firstError) {
      const rollupKeys = mergeTouchedVariantKeys(
        timeseriesTouchedKeys,
        variantMetricsTouchedKeys,
      );
      const rollups = await refreshPipelineRollupsForVariantKeys({
        keys: rollupKeys,
      });
      steps.push({ name: "targeted_rollups", ok: rollups.ok, result: rollups });
      if (!rollups.ok) firstError = rollups.firstError ?? "scrydex targeted rollups failed";
    }
  }

  const endedAt = new Date().toISOString();
  const coreOk = !firstError;
  return {
    ok: coreOk,
    provider: "SCRYDEX",
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
  return runPokemonTcgPipeline(opts);
}
