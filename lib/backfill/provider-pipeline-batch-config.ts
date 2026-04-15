import type { BackendPipelineProvider } from "@/lib/backfill/provider-registry";

export type PipelineBatchProvider = BackendPipelineProvider;
export type PipelineBatchKind = "PIPELINE" | "RETRY";

export type PipelineBatchParams = {
  providerSetId?: string | null;
  setLimit?: number;
  pageLimitPerSet?: number;
  maxRequests?: number;
  payloadLimit?: number;
  matchObservations?: number;
  timeseriesObservations?: number;
  metricsObservations?: number;
  force?: boolean;
};

type PipelineBatchPreset = {
  setLimit: number;
  maxRequests: number;
  payloadLimit: number;
  matchObservations: number;
  timeseriesObservations: number;
  metricsObservations: number;
};

type ProviderPresetMap = Record<PipelineBatchKind | "MINIMAL", PipelineBatchPreset>;

const QUEUED_BATCH_PRESETS: Record<PipelineBatchProvider, ProviderPresetMap> = {
  JUSTTCG: {
    PIPELINE: {
      setLimit: 1,
      maxRequests: 12,
      payloadLimit: 10,
      matchObservations: 30,
      timeseriesObservations: 30,
      metricsObservations: 30,
    },
    RETRY: {
      setLimit: 1,
      maxRequests: 6,
      payloadLimit: 8,
      matchObservations: 20,
      timeseriesObservations: 20,
      metricsObservations: 20,
    },
    MINIMAL: {
      setLimit: 1,
      maxRequests: 4,
      payloadLimit: 6,
      matchObservations: 12,
      timeseriesObservations: 12,
      metricsObservations: 12,
    },
  },
  SCRYDEX: {
    PIPELINE: {
      setLimit: 1,
      maxRequests: 10,
      payloadLimit: 10,
      matchObservations: 200,
      timeseriesObservations: 200,
      metricsObservations: 200,
    },
    RETRY: {
      setLimit: 1,
      maxRequests: 1,
      payloadLimit: 8,
      matchObservations: 80,
      timeseriesObservations: 80,
      metricsObservations: 80,
    },
    MINIMAL: {
      setLimit: 1,
      maxRequests: 3,
      payloadLimit: 4,
      matchObservations: 40,
      timeseriesObservations: 40,
      metricsObservations: 40,
    },
  },
  POKETRACE: {
    PIPELINE: {
      setLimit: 1,
      maxRequests: 3,
      payloadLimit: 6,
      matchObservations: 120,
      timeseriesObservations: 120,
      metricsObservations: 120,
    },
    RETRY: {
      setLimit: 1,
      maxRequests: 2,
      payloadLimit: 4,
      matchObservations: 80,
      timeseriesObservations: 80,
      metricsObservations: 80,
    },
    MINIMAL: {
      setLimit: 1,
      maxRequests: 1,
      payloadLimit: 2,
      matchObservations: 40,
      timeseriesObservations: 40,
      metricsObservations: 40,
    },
  },
};

function clampToMax(value: number | undefined, maxValue: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.floor(value), maxValue));
  }
  return maxValue;
}

export function getQueuedBatchPreset(
  provider: PipelineBatchProvider,
  kind: PipelineBatchKind,
  attempts: number = 1,
): PipelineBatchPreset {
  const providerPresets = QUEUED_BATCH_PRESETS[provider];
  if (attempts >= 4) return providerPresets.MINIMAL;
  if (attempts >= 2 && kind === "PIPELINE") return providerPresets.RETRY;
  return providerPresets[kind];
}

export function applyQueuedBatchPreset(
  provider: PipelineBatchProvider,
  kind: PipelineBatchKind,
  attempts: number,
  params: PipelineBatchParams,
): Required<Omit<PipelineBatchParams, "providerSetId" | "force" | "pageLimitPerSet">>
  & Pick<PipelineBatchParams, "providerSetId" | "force" | "pageLimitPerSet"> {
  const preset = getQueuedBatchPreset(provider, kind, attempts);
  return {
    providerSetId: params.providerSetId ?? null,
    pageLimitPerSet: params.pageLimitPerSet,
    setLimit: clampToMax(params.setLimit, preset.setLimit),
    maxRequests: clampToMax(params.maxRequests, preset.maxRequests),
    payloadLimit: clampToMax(params.payloadLimit, preset.payloadLimit),
    matchObservations: clampToMax(params.matchObservations, preset.matchObservations),
    timeseriesObservations: clampToMax(
      params.timeseriesObservations ?? params.matchObservations,
      preset.timeseriesObservations,
    ),
    metricsObservations: clampToMax(
      params.metricsObservations ?? params.timeseriesObservations ?? params.matchObservations,
      preset.metricsObservations,
    ),
    force: params.force === true,
  };
}
