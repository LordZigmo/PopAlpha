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
} = {}): Promise<PipelineResult> {
  const startedAt = new Date().toISOString();
  const steps: PipelineStep<object>[] = [];
  let firstError: string | null = null;
  let timeseriesTouchedKeys: Array<{
    canonical_slug: string;
    variant_ref: string;
    provider: string;
    grade: string;
  }> = [];

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
    const normalize = await runJustTcgRawNormalize({
      providerSetId: opts.providerSetId ?? undefined,
      payloadLimit: opts.payloadLimit,
      force: opts.force === true,
    });
    steps.push({ name: "normalize", ok: normalize.ok, result: normalize });
    if (!normalize.ok) firstError = normalize.firstError ?? "justtcg normalize failed";
  }

  if (!firstError) {
    const match = await runJustTcgNormalizedMatch({
      providerSetId: opts.providerSetId ?? undefined,
      observationLimit: opts.matchObservations,
      force: opts.force === true,
    });
    steps.push({ name: "match", ok: match.ok, result: match });
    if (!match.ok) firstError = match.firstError ?? "justtcg match failed";
  }

  if (!firstError) {
    const timeseries = await runProviderObservationTimeseries({
      provider: "JUSTTCG",
      providerSetId: opts.providerSetId ?? undefined,
      observationLimit: opts.timeseriesObservations ?? opts.matchObservations,
      force: opts.force === true,
    });
    steps.push({ name: "timeseries", ok: timeseries.ok, result: timeseries });
    if (!timeseries.ok) firstError = timeseries.firstError ?? "justtcg timeseries failed";
    timeseriesTouchedKeys = timeseries.touchedVariantKeys;
  }

  if (!firstError) {
    const variantMetrics = await runProviderObservationVariantMetrics({
      provider: "JUSTTCG",
      providerSetId: opts.providerSetId ?? undefined,
      observationLimit: opts.metricsObservations ?? opts.timeseriesObservations ?? opts.matchObservations,
    });
    steps.push({ name: "variant_metrics", ok: variantMetrics.ok, result: variantMetrics });
    if (!variantMetrics.ok) firstError = variantMetrics.firstError ?? "justtcg variant metrics failed";

    if (!firstError) {
      const rollupKeys = mergeTouchedVariantKeys(
        timeseriesTouchedKeys,
        variantMetrics.touchedVariantKeys,
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
} = {}): Promise<PipelineResult> {
  const startedAt = new Date().toISOString();
  const steps: PipelineStep<object>[] = [];
  let firstError: string | null = null;
  let timeseriesTouchedKeys: Array<{
    canonical_slug: string;
    variant_ref: string;
    provider: string;
    grade: string;
  }> = [];

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
    const normalize = await runScrydexRawNormalize({
      providerSetId: opts.providerSetId ?? undefined,
      payloadLimit: opts.payloadLimit,
      force: opts.force === true,
    });
    steps.push({ name: "normalize", ok: normalize.ok, result: normalize });
    if (!normalize.ok) firstError = normalize.firstError ?? "scrydex normalize failed";
  }

  if (!firstError) {
    const match = await runScrydexNormalizedMatch({
      providerSetId: opts.providerSetId ?? undefined,
      observationLimit: opts.matchObservations,
      force: opts.force === true,
      scanDirection: opts.matchScanDirection ?? "newest",
      mode: opts.matchMode ?? "incremental",
    });
    steps.push({ name: "match", ok: match.ok, result: match });
    if (!match.ok) firstError = match.firstError ?? "scrydex match failed";
  }

  if (!firstError) {
    const timeseries = await runProviderObservationTimeseries({
      provider: "SCRYDEX",
      providerSetId: opts.providerSetId ?? undefined,
      observationLimit: opts.timeseriesObservations ?? opts.matchObservations,
      force: opts.force === true,
    });
    steps.push({ name: "timeseries", ok: timeseries.ok, result: timeseries });
    if (!timeseries.ok) firstError = timeseries.firstError ?? "scrydex timeseries failed";
    timeseriesTouchedKeys = timeseries.touchedVariantKeys;
  }

  if (!firstError) {
    const variantMetrics = await runProviderObservationVariantMetrics({
      provider: "SCRYDEX",
      providerSetId: opts.providerSetId ?? undefined,
      observationLimit: opts.metricsObservations ?? opts.timeseriesObservations ?? opts.matchObservations,
    });
    steps.push({ name: "variant_metrics", ok: variantMetrics.ok, result: variantMetrics });
    if (!variantMetrics.ok) firstError = variantMetrics.firstError ?? "scrydex variant metrics failed";

    if (!firstError) {
      const rollupKeys = mergeTouchedVariantKeys(
        timeseriesTouchedKeys,
        variantMetrics.touchedVariantKeys,
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
} = {}): Promise<PipelineResult> {
  return runPokemonTcgPipeline(opts);
}
