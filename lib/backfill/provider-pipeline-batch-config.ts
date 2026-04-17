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

// 2026-04-17: raised PIPELINE observation caps from 100 → 250 after today's
// infrastructure cleanup (price_history_points shrunk 11M → 4.3M rows, LIKE-OR
// scans gated, DISTINCT ON rollup bug fixed, dup-key firehose silenced). The
// lower caps were a defensive measure after Incident #13 when CPU hit 99% on
// 13M-row scans — that pressure no longer exists. Coverage math: at 100 obs/
// job × 4 daily chunks = 400 obs/set/day, large sets like Cosmic Eclipse
// (~540 observations) were only 74% covered per day. 250 obs/job restores
// full daily coverage for all sets.
//
// RETRY and MINIMAL stay lower — those are the de-escalation path when jobs
// are failing, and still protect against CPU spikes on a struggling DB.
const QUEUED_BATCH_PRESETS: Record<PipelineBatchProvider, ProviderPresetMap> = {
  SCRYDEX: {
    PIPELINE: {
      setLimit: 1,
      maxRequests: 15,
      payloadLimit: 15,
      matchObservations: 250,
      timeseriesObservations: 250,
      metricsObservations: 250,
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
