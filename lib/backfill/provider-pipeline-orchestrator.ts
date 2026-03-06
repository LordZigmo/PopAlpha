import { dbAdmin } from "@/lib/db/admin";
import { runJustTcgRawIngest } from "@/lib/backfill/justtcg-raw-ingest";
import { runJustTcgRawNormalize } from "@/lib/backfill/justtcg-raw-normalize";
import { runJustTcgNormalizedMatch } from "@/lib/backfill/justtcg-normalized-match";
import { runPokemonTcgRawIngest } from "@/lib/backfill/pokemontcg-raw-ingest";
import { runPokemonTcgRawNormalize } from "@/lib/backfill/pokemontcg-raw-normalize";
import { runPokemonTcgNormalizedMatch } from "@/lib/backfill/pokemontcg-normalized-match";
import { runProviderObservationTimeseries } from "@/lib/backfill/provider-observation-timeseries";

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
  metricsRefresh: unknown;
  metricsRefreshError: string | null;
  priceChangesRefresh: unknown;
  priceChangesRefreshError: string | null;
};

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
  force?: boolean;
  retryOnly?: boolean;
} = {}): Promise<PipelineResult> {
  const startedAt = new Date().toISOString();
  const steps: PipelineStep<object>[] = [];
  let firstError: string | null = null;

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
  }

  const supabase = dbAdmin();
  let metricsRefresh: unknown = null;
  let metricsRefreshError: string | null = null;
  let priceChangesRefresh: unknown = null;
  let priceChangesRefreshError: string | null = null;

  if (!firstError) {
    try {
      const { data, error } = await supabase.rpc("refresh_card_metrics");
      if (error) metricsRefreshError = error.message;
      else metricsRefresh = data;
    } catch (err) {
      metricsRefreshError = toErrorMessage(err);
    }

    try {
      const { data, error } = await supabase.rpc("refresh_price_changes");
      if (error) priceChangesRefreshError = error.message;
      else priceChangesRefresh = data;
    } catch (err) {
      priceChangesRefreshError = toErrorMessage(err);
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
    metricsRefresh,
    metricsRefreshError,
    priceChangesRefresh,
    priceChangesRefreshError,
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
  force?: boolean;
  matchScanDirection?: "newest" | "oldest";
} = {}): Promise<PipelineResult> {
  const startedAt = new Date().toISOString();
  const steps: PipelineStep<object>[] = [];
  let firstError: string | null = null;

  const ingest = await runPokemonTcgRawIngest({
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
    const normalize = await runPokemonTcgRawNormalize({
      providerSetId: opts.providerSetId ?? undefined,
      payloadLimit: opts.payloadLimit,
      force: opts.force === true,
    });
    steps.push({ name: "normalize", ok: normalize.ok, result: normalize });
    if (!normalize.ok) firstError = normalize.firstError ?? "scrydex normalize failed";
  }

  if (!firstError) {
    const match = await runPokemonTcgNormalizedMatch({
      providerSetId: opts.providerSetId ?? undefined,
      observationLimit: opts.matchObservations,
      force: opts.force === true,
      scanDirection: opts.matchScanDirection ?? "newest",
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
  }

  const supabase = dbAdmin();
  let metricsRefresh: unknown = null;
  let metricsRefreshError: string | null = null;
  let priceChangesRefresh: unknown = null;
  let priceChangesRefreshError: string | null = null;

  if (!firstError) {
    try {
      const { data, error } = await supabase.rpc("refresh_card_metrics");
      if (error) metricsRefreshError = error.message;
      else metricsRefresh = data;
    } catch (err) {
      metricsRefreshError = toErrorMessage(err);
    }

    try {
      const { data, error } = await supabase.rpc("refresh_price_changes");
      if (error) priceChangesRefreshError = error.message;
      else priceChangesRefresh = data;
    } catch (err) {
      priceChangesRefreshError = toErrorMessage(err);
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
    metricsRefresh,
    metricsRefreshError,
    priceChangesRefresh,
    priceChangesRefreshError,
  };
}
