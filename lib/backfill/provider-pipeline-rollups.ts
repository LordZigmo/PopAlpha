import { dbAdmin } from "@/lib/db/admin";
import {
  dedupeVariantSignalRefreshKeys,
  type VariantSignalRefreshKey,
} from "@/lib/backfill/provider-derived-signals";
import { refreshSetSummaryPipeline } from "@/lib/sets/refresh";

const JOB = "provider_pipeline_rollups";
type RefreshMode = "targeted" | "full_fallback";

export type TargetedPipelineRollupResult = {
  ok: boolean;
  job: string;
  startedAt: string;
  endedAt: string;
  keysRequested: number;
  keysDeduped: number;
  canonicalCardsTargeted: number;
  cardMetricsMode: RefreshMode;
  cardMetrics: unknown;
  cardMetricsError: string | null;
  priceChangesMode: RefreshMode;
  priceChanges: unknown;
  priceChangesError: string | null;
  marketConfidenceMode: RefreshMode;
  marketConfidence: unknown;
  marketConfidenceError: string | null;
  parityMode: RefreshMode;
  parity: unknown;
  parityError: string | null;
  setSummaryMode: "incremental" | "full" | "none";
  setSummary: unknown;
  setSummaryError: string | null;
  firstError: string | null;
};

export async function refreshPipelineRollupsForVariantKeys(opts: {
  keys: Array<Partial<VariantSignalRefreshKey> | null | undefined>;
}): Promise<TargetedPipelineRollupResult> {
  const startedAt = new Date().toISOString();
  const keys = dedupeVariantSignalRefreshKeys(opts.keys);
  const canonicalSlugs = [...new Set(keys.map((key) => key.canonical_slug).filter(Boolean))];

  let cardMetrics: unknown = null;
  let cardMetricsMode: RefreshMode = "targeted";
  let cardMetricsError: string | null = null;
  let priceChanges: unknown = null;
  let priceChangesMode: RefreshMode = "targeted";
  let priceChangesError: string | null = null;
  let marketConfidence: unknown = null;
  let marketConfidenceMode: RefreshMode = "targeted";
  let marketConfidenceError: string | null = null;
  let parity: unknown = null;
  let parityMode: RefreshMode = "targeted";
  let parityError: string | null = null;
  let setSummary: unknown = null;
  let setSummaryError: string | null = null;
  let setSummaryMode: "incremental" | "full" | "none" = "none";

  if (keys.length === 0 || canonicalSlugs.length === 0) {
    return {
      ok: true,
      job: JOB,
      startedAt,
      endedAt: new Date().toISOString(),
      keysRequested: opts.keys.length,
      keysDeduped: 0,
      canonicalCardsTargeted: 0,
      cardMetricsMode,
      cardMetrics: null,
      cardMetricsError: null,
      priceChangesMode,
      priceChanges: null,
      priceChangesError: null,
      marketConfidenceMode,
      marketConfidence: null,
      marketConfidenceError: null,
      parityMode,
      parity: null,
      parityError: null,
      setSummaryMode,
      setSummary,
      setSummaryError,
      firstError: null,
    };
  }

  const supabase = dbAdmin();

  const isMissingFunction = (message: string | null): boolean => {
    if (!message) return false;
    const normalized = message.toLowerCase();
    return normalized.includes("function")
      && (normalized.includes("does not exist") || normalized.includes("could not find the function"));
  };

  try {
    const { data, error } = await supabase.rpc("refresh_card_metrics_for_variants", { keys });
    if (error) {
      if (!isMissingFunction(error.message)) {
        cardMetricsError = error.message;
      } else {
        cardMetricsMode = "full_fallback";
        const fallback = await supabase.rpc("refresh_card_metrics");
        if (fallback.error) cardMetricsError = fallback.error.message;
        else cardMetrics = fallback.data;
      }
    } else {
      cardMetrics = data;
    }
  } catch (err) {
    cardMetricsError = err instanceof Error ? err.message : String(err);
  }

  try {
    const { data, error } = await supabase.rpc("refresh_price_changes_for_cards", {
      p_canonical_slugs: canonicalSlugs,
    });
    if (error) {
      if (!isMissingFunction(error.message)) {
        priceChangesError = error.message;
      } else {
        priceChangesMode = "full_fallback";
        const fallback = await supabase.rpc("refresh_price_changes");
        if (fallback.error) priceChangesError = fallback.error.message;
        else priceChanges = fallback.data;
      }
    } else {
      priceChanges = data;
    }
  } catch (err) {
    priceChangesError = err instanceof Error ? err.message : String(err);
  }

  try {
    const { data, error } = await supabase.rpc("refresh_card_market_confidence_for_cards", {
      p_canonical_slugs: canonicalSlugs,
    });
    if (error) {
      if (!isMissingFunction(error.message)) {
        marketConfidenceError = error.message;
      } else {
        marketConfidenceMode = "full_fallback";
        const fallback = await supabase.rpc("refresh_card_market_confidence");
        if (fallback.error) marketConfidenceError = fallback.error.message;
        else marketConfidence = fallback.data;
      }
    } else {
      marketConfidence = data;
    }
  } catch (err) {
    marketConfidenceError = err instanceof Error ? err.message : String(err);
  }

  try {
    const { data, error } = await supabase.rpc("refresh_canonical_raw_provider_parity_for_cards", {
      p_canonical_slugs: canonicalSlugs,
      p_window_days: 30,
    });
    if (error) {
      if (!isMissingFunction(error.message)) {
        parityError = error.message;
      } else {
        parityMode = "full_fallback";
        const fallback = await supabase.rpc("refresh_canonical_raw_provider_parity", { p_window_days: 30 });
        if (fallback.error) parityError = fallback.error.message;
        else parity = fallback.data;
      }
    } else {
      parity = data;
    }
  } catch (err) {
    parityError = err instanceof Error ? err.message : String(err);
  }

  const setSummaryResult = await refreshSetSummaryPipeline({
    supabase,
    keys,
  });
  setSummaryMode = setSummaryResult.mode;
  setSummary = setSummaryResult.result;
  setSummaryError = setSummaryResult.error;

  const firstError = cardMetricsError
    ?? priceChangesError
    ?? marketConfidenceError
    ?? parityError
    ?? setSummaryError;

  return {
    ok: firstError === null,
    job: JOB,
    startedAt,
    endedAt: new Date().toISOString(),
    keysRequested: opts.keys.length,
    keysDeduped: keys.length,
    canonicalCardsTargeted: canonicalSlugs.length,
    cardMetricsMode,
    cardMetrics,
    cardMetricsError,
    priceChangesMode,
    priceChanges,
    priceChangesError,
    marketConfidenceMode,
    marketConfidence,
    marketConfidenceError,
    parityMode,
    parity,
    parityError,
    setSummaryMode,
    setSummary,
    setSummaryError,
    firstError,
  };
}
