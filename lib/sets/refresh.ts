import type { SupabaseClient } from "@supabase/supabase-js";

export type SetSummaryVariantKey = {
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  grade: string;
};

type PipelineRefreshResult = {
  mode: "incremental" | "full" | "none";
  result: unknown;
  error: string | null;
};

export async function refreshSetSummaryPipeline(params: {
  supabase: SupabaseClient;
  keys?: SetSummaryVariantKey[];
  asOfDate?: string;
  lookbackDays?: number;
  incrementalLimit?: number;
}): Promise<PipelineRefreshResult> {
  const { supabase, asOfDate, incrementalLimit = 500 } = params;
  const deduped = new Map<string, SetSummaryVariantKey>();

  for (const key of params.keys ?? []) {
    if (!key?.canonical_slug || !key?.variant_ref || !key?.provider || !key?.grade) continue;
    deduped.set(
      `${key.canonical_slug}::${key.variant_ref}::${key.provider}::${key.grade}`,
      key,
    );
  }

  const keys = [...deduped.values()];
  const targetAsOfDate = asOfDate ?? new Date().toISOString().slice(0, 10);
  const lookbackDays = Math.max(35, Math.trunc(params.lookbackDays ?? 35));

  try {
    if (keys.length > 0 && keys.length <= incrementalLimit) {
      const { data, error } = await supabase.rpc("refresh_set_summary_pipeline_for_variants", {
        keys,
        target_as_of_date: targetAsOfDate,
        lookback_days: lookbackDays,
      });
      if (error) {
        return { mode: "incremental", result: null, error: error.message };
      }
      return { mode: "incremental", result: data, error: null };
    }

    const { data, error } = await supabase.rpc("refresh_set_summary_pipeline", {
      target_as_of_date: targetAsOfDate,
      lookback_days: lookbackDays,
    });
    if (error) {
      return { mode: "full", result: null, error: error.message };
    }

    return {
      mode: "full",
      result: data,
      error: null,
    };
  } catch (err) {
    return {
      mode: keys.length > 0 && keys.length <= incrementalLimit ? "incremental" : "full",
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
