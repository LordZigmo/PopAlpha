import type { SupabaseClient } from "@supabase/supabase-js";

export type JpIngestionProvider = "YAHOO_JP" | "SNKRDUNK";

export type JpIngestionAttemptStatus =
  | "ok"
  | "low-sample"
  | "scrape-failed"
  | "write-failed"
  | "no-query";

export type JpIngestionRunMode = "processed" | "halted" | "no-work" | "failed";

export type JpIngestionRunCounters = {
  candidatesAvailable: number;
  processed: number;
  written: number;
  lowSample: number;
  scrapeFailed: number;
  writeFailed: number;
  noQuery: number;
};

type DbClient = SupabaseClient;

const PAGE_SIZE = 1000;

function truncateText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export async function createJpIngestionRun(
  supabase: DbClient,
  input: {
    provider: JpIngestionProvider;
    route: string;
    batchSize: number;
    startedAtIso?: string;
  },
): Promise<string | null> {
  const { data, error } = await supabase
    .from("jp_ingestion_runs")
    .insert({
      provider: input.provider,
      route: input.route,
      batch_size: input.batchSize,
      started_at: input.startedAtIso ?? new Date().toISOString(),
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    console.error("[jp-ingestion] failed to create run log", {
      provider: input.provider,
      error: error.message,
    });
    return null;
  }

  return data?.id ?? null;
}

export async function completeJpIngestionRun(
  supabase: DbClient,
  runId: string | null,
  input: {
    status: "succeeded" | "failed";
    mode: JpIngestionRunMode;
    counters: JpIngestionRunCounters;
    haltReason?: string | null;
    error?: string | null;
    elapsedMs: number;
    result?: Record<string, unknown>;
  },
): Promise<void> {
  if (!runId) return;

  const { error } = await supabase
    .from("jp_ingestion_runs")
    .update({
      status: input.status,
      mode: input.mode,
      candidates_available: input.counters.candidatesAvailable,
      processed: input.counters.processed,
      written: input.counters.written,
      low_sample: input.counters.lowSample,
      scrape_failed: input.counters.scrapeFailed,
      write_failed: input.counters.writeFailed,
      no_query: input.counters.noQuery,
      halt_reason: truncateText(input.haltReason, 8000),
      error: truncateText(input.error, 8000),
      elapsed_ms: Math.max(0, Math.round(input.elapsedMs)),
      result: input.result ?? {},
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    console.error("[jp-ingestion] failed to complete run log", {
      runId,
      error: error.message,
    });
  }
}

export async function recordJpIngestionAttempt(
  supabase: DbClient,
  input: {
    runId: string | null;
    provider: JpIngestionProvider;
    canonicalSlug: string;
    sourceKey?: string | null;
    printingId?: string | null;
    status: JpIngestionAttemptStatus;
    rawCount?: number | null;
    rowsWritten?: number | null;
    priceUsd?: number | null;
    sampleCount?: number | null;
    reason?: string | null;
    elapsedMs?: number | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase
    .from("jp_ingestion_attempts")
    .insert({
      run_id: input.runId,
      provider: input.provider,
      canonical_slug: input.canonicalSlug,
      source_key: input.sourceKey ?? null,
      printing_id: input.printingId ?? null,
      status: input.status,
      raw_count: input.rawCount ?? null,
      rows_written: input.rowsWritten ?? 0,
      price_usd: input.priceUsd ?? null,
      sample_count: input.sampleCount ?? null,
      reason: truncateText(input.reason, 8000),
      elapsed_ms: input.elapsedMs == null ? null : Math.max(0, Math.round(input.elapsedMs)),
      metadata: input.metadata ?? {},
    });

  if (error) {
    console.error("[jp-ingestion] failed to record attempt", {
      provider: input.provider,
      canonicalSlug: input.canonicalSlug,
      sourceKey: input.sourceKey ?? null,
      status: input.status,
      error: error.message,
    });
  }
}

export async function loadRecentJpIngestionSuppression(
  supabase: DbClient,
  input: {
    provider: JpIngestionProvider;
    statuses: JpIngestionAttemptStatus[];
    sinceIso: string;
  },
): Promise<{ slugs: Set<string>; sourceKeys: Set<string> }> {
  const slugs = new Set<string>();
  const sourceKeys = new Set<string>();

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("jp_ingestion_attempts")
      .select("canonical_slug, source_key")
      .eq("provider", input.provider)
      .in("status", input.statuses)
      .gte("attempted_at", input.sinceIso)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error("[jp-ingestion] failed to load recent attempt suppression", {
        provider: input.provider,
        error: error.message,
      });
      return { slugs, sourceKeys };
    }

    const rows = (data ?? []) as Array<{ canonical_slug: string | null; source_key: string | null }>;
    for (const row of rows) {
      if (row.canonical_slug) slugs.add(row.canonical_slug);
      if (row.source_key) sourceKeys.add(row.source_key);
    }

    if (rows.length < PAGE_SIZE) break;
  }

  return { slugs, sourceKeys };
}
