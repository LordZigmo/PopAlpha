import { dbAdmin } from "@/lib/db/admin";
import { runJustTcgPipeline, runScrydexPipeline } from "@/lib/backfill/provider-pipeline-orchestrator";

export type PipelineProvider = "JUSTTCG" | "SCRYDEX";
export type PipelineJobKind = "PIPELINE" | "RETRY";

export type PipelineJobParams = {
  providerSetId?: string | null;
  setLimit?: number;
  pageLimitPerSet?: number;
  maxRequests?: number;
  payloadLimit?: number;
  matchObservations?: number;
  timeseriesObservations?: number;
  force?: boolean;
};

type PipelineJobRow = {
  id: number;
  provider: PipelineProvider;
  job_kind: PipelineJobKind;
  status: "QUEUED" | "RUNNING" | "RETRY" | "SUCCEEDED" | "FAILED";
  attempts: number;
  max_attempts: number;
  params_json: Record<string, unknown> | null;
  run_after: string;
  created_at: string;
};

export async function enqueuePipelineJob(input: {
  provider: PipelineProvider;
  jobKind: PipelineJobKind;
  params: PipelineJobParams;
  priority?: number;
  maxAttempts?: number;
}): Promise<{ enqueued: boolean; jobId: number | null; reason: string }> {
  const supabase = dbAdmin();
  const safeParams = {
    ...input.params,
    providerSetId: input.params.providerSetId ?? null,
  };

  const { data: existing, error: existingError } = await supabase
    .from("pipeline_jobs")
    .select("id, status")
    .eq("provider", input.provider)
    .eq("job_kind", input.jobKind)
    .in("status", ["QUEUED", "RUNNING", "RETRY"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: number; status: string }>();
  if (existingError) throw new Error(`pipeline_jobs(existing): ${existingError.message}`);
  if (existing?.id) {
    return { enqueued: false, jobId: existing.id, reason: `existing_${existing.status.toLowerCase()}` };
  }

  const { data, error } = await supabase
    .from("pipeline_jobs")
    .insert({
      provider: input.provider,
      job_kind: input.jobKind,
      params_json: safeParams,
      priority: input.priority ?? 100,
      max_attempts: input.maxAttempts ?? 6,
      status: "QUEUED",
    })
    .select("id")
    .single<{ id: number }>();
  if (error) throw new Error(`pipeline_jobs(insert): ${error.message}`);
  return { enqueued: true, jobId: data.id, reason: "queued" };
}

export async function claimNextPipelineJob(workerId: string): Promise<PipelineJobRow | null> {
  const supabase = dbAdmin();
  const { data, error } = await supabase.rpc("claim_pipeline_job", { p_worker: workerId });
  if (error) throw new Error(`claim_pipeline_job: ${error.message}`);
  if (!data) return null;
  return data as PipelineJobRow;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const asInt = Math.floor(value);
  return asInt > 0 ? asInt : undefined;
}

function parseParams(raw: Record<string, unknown> | null | undefined): PipelineJobParams {
  return {
    providerSetId: typeof raw?.providerSetId === "string" && raw.providerSetId.trim()
      ? raw.providerSetId.trim()
      : null,
    setLimit: parsePositiveInt(raw?.setLimit),
    pageLimitPerSet: parsePositiveInt(raw?.pageLimitPerSet),
    maxRequests: parsePositiveInt(raw?.maxRequests),
    payloadLimit: parsePositiveInt(raw?.payloadLimit),
    matchObservations: parsePositiveInt(raw?.matchObservations),
    timeseriesObservations: parsePositiveInt(raw?.timeseriesObservations),
    force: raw?.force === true,
  };
}

export async function executeClaimedPipelineJob(job: PipelineJobRow): Promise<{ ok: boolean; result: unknown; error: string | null }> {
  const params = parseParams(job.params_json);

  try {
    if (job.provider === "JUSTTCG") {
      const result = await runJustTcgPipeline({
        providerSetId: params.providerSetId ?? undefined,
        setLimit: params.setLimit,
        pageLimitPerSet: params.pageLimitPerSet,
        maxRequests: params.maxRequests,
        payloadLimit: params.payloadLimit,
        matchObservations: params.matchObservations,
        timeseriesObservations: params.timeseriesObservations,
        force: params.force === true,
        retryOnly: job.job_kind === "RETRY",
      });
      return { ok: result.ok, result, error: result.firstError ?? null };
    }

    const result = await runScrydexPipeline({
      providerSetId: params.providerSetId ?? undefined,
      setLimit: params.setLimit,
      pageLimitPerSet: params.pageLimitPerSet,
      maxRequests: params.maxRequests,
      payloadLimit: params.payloadLimit,
      matchObservations: params.matchObservations,
      timeseriesObservations: params.timeseriesObservations,
      force: params.force === true,
      matchScanDirection: job.job_kind === "RETRY" ? "oldest" : "newest",
    });
    return { ok: result.ok, result, error: result.firstError ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: null, error: message };
  }
}

export async function completePipelineJob(input: {
  jobId: number;
  ok: boolean;
  result?: unknown;
  error?: string | null;
  retryDelaySeconds?: number;
}): Promise<void> {
  const supabase = dbAdmin();
  const { error } = await supabase.rpc("complete_pipeline_job", {
    p_job_id: input.jobId,
    p_ok: input.ok,
    p_result: input.result ?? null,
    p_error: input.error ?? null,
    p_retry_delay_seconds: input.retryDelaySeconds ?? 300,
  });
  if (error) throw new Error(`complete_pipeline_job: ${error.message}`);
}

export function retryDelayForAttempt(attempt: number): number {
  const base = Math.max(1, attempt);
  return Math.min(60 * 60, 60 * Math.pow(2, Math.min(base, 6)));
}
