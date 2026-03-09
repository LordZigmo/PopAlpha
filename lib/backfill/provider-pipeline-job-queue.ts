import { dbAdmin } from "@/lib/db/admin";
import { runJustTcgPipeline, runScrydexPipeline } from "@/lib/backfill/provider-pipeline-orchestrator";
import {
  applyQueuedBatchPreset,
  type PipelineBatchKind,
  type PipelineBatchParams,
  type PipelineBatchProvider,
} from "@/lib/backfill/provider-pipeline-batch-config";

export type PipelineProvider = PipelineBatchProvider;
export type PipelineJobKind = PipelineBatchKind;
export type PipelineJobParams = PipelineBatchParams;

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
  locked_by?: string | null;
};

const DEFAULT_JOB_TIMEOUT_MS = process.env.PIPELINE_JOB_TIMEOUT_MS
  ? Math.max(5000, parseInt(process.env.PIPELINE_JOB_TIMEOUT_MS, 10))
  : 240000;
const DEFAULT_STALE_RECLAIM_SECONDS = process.env.PIPELINE_JOB_STALE_RECLAIM_SECONDS
  ? Math.max(60, parseInt(process.env.PIPELINE_JOB_STALE_RECLAIM_SECONDS, 10))
  : Math.max(360, Math.ceil(DEFAULT_JOB_TIMEOUT_MS / 1000) + 120);
const HEARTBEAT_INTERVAL_MS = process.env.PIPELINE_JOB_HEARTBEAT_MS
  ? Math.max(5000, parseInt(process.env.PIPELINE_JOB_HEARTBEAT_MS, 10))
  : 30000;
const MAX_JOB_RESULT_DEPTH = 6;
const MAX_JOB_RESULT_ARRAY_ITEMS = 8;
const MAX_JOB_RESULT_OBJECT_KEYS = 40;
const MAX_JOB_RESULT_STRING_LENGTH = 1200;

function timeoutResult(timeoutMs: number): { ok: boolean; result: unknown; error: string } {
  return {
    ok: false,
    result: null,
    error: `PIPELINE_JOB_TIMEOUT after ${Math.max(1, Math.floor(timeoutMs / 1000))}s`,
  };
}

function compactPipelineJobValue(value: unknown, depth: number = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    return value.length > MAX_JOB_RESULT_STRING_LENGTH
      ? `${value.slice(0, MAX_JOB_RESULT_STRING_LENGTH)}...[truncated]`
      : value;
  }

  if (depth >= MAX_JOB_RESULT_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    const sample = value
      .slice(0, MAX_JOB_RESULT_ARRAY_ITEMS)
      .map((entry) => compactPipelineJobValue(entry, depth + 1));
    if (value.length <= MAX_JOB_RESULT_ARRAY_ITEMS) return sample;
    return [
      ...sample,
      { _truncated_items: value.length - MAX_JOB_RESULT_ARRAY_ITEMS },
    ];
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, MAX_JOB_RESULT_OBJECT_KEYS)) {
      output[key] = compactPipelineJobValue(entryValue, depth + 1);
    }
    if (entries.length > MAX_JOB_RESULT_OBJECT_KEYS) {
      output._truncated_keys = entries.length - MAX_JOB_RESULT_OBJECT_KEYS;
    }
    return output;
  }

  return String(value);
}

function compactPipelineJobResult(result: unknown): unknown {
  return compactPipelineJobValue(result);
}

async function touchPipelineJob(jobId: number, workerId: string | null | undefined): Promise<void> {
  const supabase = dbAdmin();
  const { error } = await supabase
    .from("pipeline_jobs")
    .update({
      locked_at: new Date().toISOString(),
      locked_by: workerId ?? "worker",
    })
    .eq("id", jobId)
    .eq("status", "RUNNING");
  if (error) {
    throw new Error(`pipeline_jobs(heartbeat): ${error.message}`);
  }
}

function completionStatusFromRow(row: {
  attempts: number;
  max_attempts: number;
}, ok: boolean): "SUCCEEDED" | "FAILED" | "RETRY" {
  if (ok) return "SUCCEEDED";
  if (row.attempts >= row.max_attempts) return "FAILED";
  return "RETRY";
}

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

export async function claimNextPipelineJob(
  workerId: string,
  staleAfterSeconds: number = DEFAULT_STALE_RECLAIM_SECONDS,
): Promise<PipelineJobRow | null> {
  const supabase = dbAdmin();
  const safeStaleAfterSeconds = Math.max(60, Math.floor(staleAfterSeconds));
  const { data, error } = await supabase.rpc("claim_pipeline_job", {
    p_worker: workerId,
    p_stale_after_seconds: safeStaleAfterSeconds,
  });
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
    metricsObservations: parsePositiveInt(raw?.metricsObservations),
    force: raw?.force === true,
  };
}

export async function executeClaimedPipelineJob(
  job: PipelineJobRow,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; result: unknown; error: string | null }> {
  const params = applyQueuedBatchPreset(
    job.provider,
    job.job_kind,
    job.attempts,
    parseParams(job.params_json),
  );
  const timeoutMs = Math.max(5000, Math.floor(opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS));
  const deadlineMs = Date.now() + timeoutMs;
  const timeoutPromise = new Promise<{ ok: boolean; result: unknown; error: string }>((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      resolve(timeoutResult(timeoutMs));
    }, timeoutMs) as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
  });
  const heartbeat = setInterval(() => {
    void touchPipelineJob(job.id, job.locked_by).catch(() => {
      // Keep the current run alive even if heartbeat updates fail transiently.
    });
  }, HEARTBEAT_INTERVAL_MS) as ReturnType<typeof setInterval> & { unref?: () => void };
  heartbeat.unref?.();

  try {
    const workPromise = (async (): Promise<{ ok: boolean; result: unknown; error: string | null }> => {
      if (job.provider === "JUSTTCG") {
        const result = await runJustTcgPipeline({
          providerSetId: params.providerSetId ?? undefined,
          setLimit: params.setLimit,
          pageLimitPerSet: params.pageLimitPerSet,
          maxRequests: params.maxRequests,
          payloadLimit: params.payloadLimit,
          matchObservations: params.matchObservations,
          timeseriesObservations: params.timeseriesObservations,
          metricsObservations: params.metricsObservations,
          force: params.force === true,
          retryOnly: job.job_kind === "RETRY",
          deadlineMs,
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
        metricsObservations: params.metricsObservations,
        force: params.force === true,
        matchScanDirection: job.job_kind === "RETRY" ? "oldest" : "newest",
        matchMode: job.job_kind === "RETRY" ? "backlog" : "incremental",
        deadlineMs,
      });
      return { ok: result.ok, result, error: result.firstError ?? null };
    })();
    return await Promise.race([workPromise, timeoutPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: null, error: message };
  } finally {
    clearInterval(heartbeat);
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
  const safeResult = compactPipelineJobResult(input.result ?? null);
  const { error } = await supabase.rpc("complete_pipeline_job", {
    p_job_id: input.jobId,
    p_ok: input.ok,
    p_result: safeResult,
    p_error: input.error ?? null,
    p_retry_delay_seconds: input.retryDelaySeconds ?? 300,
  });
  if (!error) return;

  const { data: row, error: rowError } = await supabase
    .from("pipeline_jobs")
    .select("attempts, max_attempts")
    .eq("id", input.jobId)
    .maybeSingle<{ attempts: number; max_attempts: number }>();
  if (rowError) {
    throw new Error(`complete_pipeline_job: ${error.message}; fallback_select: ${rowError.message}`);
  }
  if (!row) {
    throw new Error(`complete_pipeline_job: ${error.message}; fallback_select: missing job ${input.jobId}`);
  }

  const status = completionStatusFromRow(row, input.ok);
  const updatePayload: Record<string, unknown> = {
    status,
    locked_at: null,
    locked_by: null,
    finished_at: status === "SUCCEEDED" || status === "FAILED" ? new Date().toISOString() : null,
    last_error: input.ok ? null : String(input.error ?? "pipeline job failed").slice(0, 8000),
    last_result: safeResult,
  };
  if (status === "RETRY") {
    updatePayload.run_after = new Date(
      Date.now() + Math.max(30, input.retryDelaySeconds ?? 300) * 1000,
    ).toISOString();
  }

  const { error: updateError } = await supabase
    .from("pipeline_jobs")
    .update(updatePayload)
    .eq("id", input.jobId);
  if (updateError) {
    throw new Error(`complete_pipeline_job: ${error.message}; fallback_update: ${updateError.message}`);
  }
}

export function retryDelayForAttempt(attempt: number): number {
  const base = Math.max(1, attempt);
  return Math.min(60 * 60, 60 * Math.pow(2, Math.min(base, 6)));
}
