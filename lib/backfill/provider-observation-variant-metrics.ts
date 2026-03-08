import { dbAdmin } from "@/lib/db/admin";
import {
  buildProviderCardMapKey,
  loadProviderCardMapByKeys,
  type ProviderCardMapRow,
} from "@/lib/backfill/provider-card-map";
import {
  refreshDerivedSignalsForVariantKeys,
  type VariantSignalRefreshKey,
} from "@/lib/backfill/provider-derived-signals";
import { buildRawVariantRef } from "@/lib/identity/variant-ref.mjs";

const JOB = "provider_observation_variant_metrics";
const DEFAULT_OBSERVATIONS_PER_RUN = process.env.PROVIDER_OBSERVATION_VARIANT_METRICS_OBSERVATIONS_PER_RUN
  ? parseInt(process.env.PROVIDER_OBSERVATION_VARIANT_METRICS_OBSERVATIONS_PER_RUN, 10)
  : 300;
const SCAN_PAGE_SIZE = 100;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

type SupportedProvider = "JUSTTCG" | "SCRYDEX";

type MatchScanRow = {
  provider_normalized_observation_id: string;
};

type NormalizedHistoryPoint = {
  ts: string;
  price: number;
  currency: string;
};

type ObservationRow = {
  id: string;
  provider: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  asset_type: "single" | "sealed";
  normalized_condition?: string | null;
  observed_price: number | null;
  currency: string;
  observed_at: string;
  history_points_30d: unknown;
  history_points_30d_count: number | null;
  metadata: Record<string, unknown> | null;
};

type CandidateRow = {
  mapping: ProviderCardMapRow;
  observation: ObservationRow;
};

type PriceHistoryCountRow = {
  canonical_slug: string;
  variant_ref: string;
};

type VariantMetricsWriteRow = {
  canonical_slug: string;
  printing_id: string;
  variant_ref: string;
  provider: SupportedProvider;
  grade: "RAW";
  provider_trend_slope_7d: number | null;
  provider_cov_price_30d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_price_changes_count_30d: number | null;
  provider_as_of_ts: string;
  history_points_30d: number;
  updated_at: string;
};

type MetricsSample = {
  canonicalSlug: string;
  printingId: string;
  variantRef: string;
  providerSetId: string | null;
  providerCardId: string;
  providerVariantId: string;
  providerTrendSlope7d: number | null;
  providerCovPrice30d: number | null;
  providerPriceRelativeTo30dRange: number | null;
  providerPriceChangesCount30d: number | null;
  providerAsOfTs: string;
  historyPoints30d: number;
};

type VariantMetricsResult = {
  ok: boolean;
  job: string;
  provider: SupportedProvider;
  startedAt: string;
  endedAt: string;
  observationsRequested: number;
  observationsScanned: number;
  observationsProcessed: number;
  observationsSkippedNoMatch: number;
  observationsSkippedNoPrice: number;
  observationsSkippedCondition: number;
  observationsSkippedNonSingle: number;
  metricsRowsUpserted: number;
  signalRowsUpdated: number;
  variantSignalsLatestRows: number;
  firstError: string | null;
  sampleRows: MetricsSample[];
  touchedVariantKeys: VariantSignalRefreshKey[];
};

type ProviderAnalytics = {
  provider_trend_slope_7d: number | null;
  provider_cov_price_30d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_price_changes_count_30d: number | null;
};

function roundMetric(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(4));
}

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function shouldWriteRawForCondition(provider: SupportedProvider, condition: string | null | undefined): boolean {
  if (provider !== "JUSTTCG") return true;
  const normalized = String(condition ?? "").trim().toLowerCase();
  return normalized === "nm" || normalized === "mint";
}

function parseHistoryPoints(raw: unknown): NormalizedHistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  const rows: NormalizedHistoryPoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const ts = String(row.ts ?? "").trim();
    const price = toFiniteNumber(row.price);
    const currency = String(row.currency ?? "USD").trim().toUpperCase();
    if (!ts || price === null || price <= 0) continue;
    rows.push({
      ts,
      price,
      currency,
    });
  }
  rows.sort((left, right) => left.ts.localeCompare(right.ts));
  return rows;
}

function deriveTrendSlope7d(points: NormalizedHistoryPoint[]): number | null {
  if (points.length < 2) return null;
  const latestMs = Date.parse(points[points.length - 1].ts);
  if (!Number.isFinite(latestMs)) return null;
  const cutoffMs = latestMs - (7 * 24 * 60 * 60 * 1000);
  const window = points.filter((point) => {
    const tsMs = Date.parse(point.ts);
    return Number.isFinite(tsMs) && tsMs >= cutoffMs;
  });
  if (window.length < 2) return null;

  const baseMs = Date.parse(window[0].ts);
  if (!Number.isFinite(baseMs)) return null;
  const xs = window.map((point) => (Date.parse(point.ts) - baseMs) / (24 * 60 * 60 * 1000));
  const ys = window.map((point) => point.price);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  if (denominator === 0) return null;
  return roundMetric(numerator / denominator);
}

function deriveCovPrice30d(points: NormalizedHistoryPoint[]): number | null {
  if (points.length < 2) return null;
  const prices = points.map((point) => point.price).filter((value) => value > 0);
  if (prices.length < 2) return null;
  const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  if (mean <= 0) return null;
  const variance = prices.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / prices.length;
  return roundMetric(Math.sqrt(variance) / mean);
}

function derivePriceRelativeTo30dRange(points: NormalizedHistoryPoint[], latestPrice: number | null): number | null {
  if (points.length === 0 || latestPrice === null || latestPrice <= 0) return null;
  const prices = points.map((point) => point.price).filter((value) => value > 0);
  if (prices.length === 0) return null;
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice <= minPrice) return null;
  return roundMetric((latestPrice - minPrice) / (maxPrice - minPrice));
}

function derivePriceChangesCount30d(points: NormalizedHistoryPoint[]): number | null {
  if (points.length < 2) return 0;
  let changes = 0;
  let previousPrice = points[0].price;
  for (let i = 1; i < points.length; i += 1) {
    const currentPrice = points[i].price;
    if (Math.abs(currentPrice - previousPrice) > 1e-9) changes += 1;
    previousPrice = currentPrice;
  }
  return changes;
}

function extractProviderAnalytics(params: {
  provider: SupportedProvider;
  metadata: Record<string, unknown> | null;
  historyPoints30d: NormalizedHistoryPoint[];
  observedPrice: number | null;
}): ProviderAnalytics {
  if (params.provider !== "JUSTTCG") {
    return {
      provider_trend_slope_7d: deriveTrendSlope7d(params.historyPoints30d),
      provider_cov_price_30d: deriveCovPrice30d(params.historyPoints30d),
      provider_price_relative_to_30d_range: derivePriceRelativeTo30dRange(params.historyPoints30d, params.observedPrice),
      provider_price_changes_count_30d: derivePriceChangesCount30d(params.historyPoints30d),
    };
  }

  const providerAnalytics = (
    params.metadata
    && typeof params.metadata.providerAnalytics === "object"
    && params.metadata.providerAnalytics !== null
  ) ? params.metadata.providerAnalytics as Record<string, unknown> : {};

  const fallback = {
    provider_trend_slope_7d: deriveTrendSlope7d(params.historyPoints30d),
    provider_cov_price_30d: deriveCovPrice30d(params.historyPoints30d),
    provider_price_relative_to_30d_range: derivePriceRelativeTo30dRange(params.historyPoints30d, params.observedPrice),
    provider_price_changes_count_30d: derivePriceChangesCount30d(params.historyPoints30d),
  };

  return {
    provider_trend_slope_7d: toFiniteNumber(providerAnalytics.provider_trend_slope_7d) ?? fallback.provider_trend_slope_7d,
    provider_cov_price_30d: toFiniteNumber(providerAnalytics.provider_cov_price_30d) ?? fallback.provider_cov_price_30d,
    provider_price_relative_to_30d_range: toFiniteNumber(providerAnalytics.provider_price_relative_to_30d_range) ?? fallback.provider_price_relative_to_30d_range,
    provider_price_changes_count_30d: toFiniteNumber(providerAnalytics.provider_price_changes_count_30d) ?? fallback.provider_price_changes_count_30d,
  };
}

async function loadCandidateRows(params: {
  provider: SupportedProvider;
  observationLimit: number;
  providerSetId?: string | null;
}): Promise<{
  rows: CandidateRow[];
  scanned: number;
}> {
  const supabase = dbAdmin();
  const selected: CandidateRow[] = [];
  let scanned = 0;

  for (let from = 0; selected.length < params.observationLimit; from += SCAN_PAGE_SIZE) {
    let scanQuery = supabase
      .from("provider_observation_matches")
      .select("provider_normalized_observation_id")
      .eq("provider", params.provider)
      .eq("match_status", "MATCHED")
      .order("updated_at", { ascending: false })
      .range(from, from + SCAN_PAGE_SIZE - 1);

    if (params.providerSetId) {
      scanQuery = scanQuery.eq("provider_set_id", params.providerSetId);
    }

    const { data, error } = await scanQuery;
    if (error) throw new Error(`provider_observation_matches(scan): ${error.message}`);

    const scanRows = (data ?? []) as MatchScanRow[];
    if (scanRows.length === 0) break;
    scanned += scanRows.length;

    const selectedIds = scanRows
      .map((row) => row.provider_normalized_observation_id)
      .slice(0, Math.max(0, params.observationLimit - selected.length));

    if (selectedIds.length === 0) continue;

    const { data: observationRows, error: observationError } = await supabase
      .from("provider_normalized_observations")
      .select([
        "id",
        "provider",
        "provider_set_id",
        "provider_card_id",
        "provider_variant_id",
        "asset_type",
        "normalized_condition",
        "observed_price",
        "currency",
        "observed_at",
        "history_points_30d",
        "history_points_30d_count",
        "metadata",
      ].join(", "))
      .in("id", selectedIds)
      .eq("provider", params.provider);
    if (observationError) {
      throw new Error(`provider_normalized_observations(load selected): ${observationError.message}`);
    }

    const observations = (observationRows ?? []) as unknown as ObservationRow[];
    const observationById = new Map<string, ObservationRow>();
    for (const row of observations) {
      observationById.set(row.id, row);
    }

    const providerCardMapByKey = await loadProviderCardMapByKeys({
      provider: params.provider,
      providerKeys: observations.map((row) => buildProviderCardMapKey(row.provider_card_id, row.provider_variant_id)),
    });

    for (const observationId of selectedIds) {
      const observation = observationById.get(observationId);
      if (!observation) continue;
      const providerKey = buildProviderCardMapKey(observation.provider_card_id, observation.provider_variant_id);
      const mapping = providerCardMapByKey.get(providerKey) ?? null;
      if (!mapping || mapping.mapping_status !== "MATCHED" || !mapping.canonical_slug || !mapping.printing_id) {
        continue;
      }
      selected.push({ mapping, observation });
      if (selected.length >= params.observationLimit) break;
    }
  }

  return { rows: selected, scanned };
}

async function loadHistoryPointCounts(params: {
  provider: SupportedProvider;
  keys: Array<{ canonicalSlug: string; variantRef: string }>;
  sinceIso: string;
}): Promise<Map<string, number>> {
  const dedupedKeys = Array.from(new Set(
    params.keys
      .map((key) => `${key.canonicalSlug}::${key.variantRef}`)
      .filter(Boolean),
  ));
  const counts = new Map<string, number>();
  if (dedupedKeys.length === 0) return counts;

  const supabase = dbAdmin();
  const pageSize = 50;

  for (let i = 0; i < dedupedKeys.length; i += pageSize) {
    const chunk = dedupedKeys.slice(i, i + pageSize);
    const slugSet = [...new Set(chunk.map((key) => key.split("::")[0]).filter(Boolean))];
    const variantRefSet = [...new Set(chunk.map((key) => key.slice(key.indexOf("::") + 2)).filter(Boolean))];
    if (slugSet.length === 0 || variantRefSet.length === 0) continue;

    const { data, error } = await supabase
      .from("price_history_points")
      .select("canonical_slug, variant_ref")
      .eq("provider", params.provider)
      .in("canonical_slug", slugSet)
      .in("variant_ref", variantRefSet)
      .gte("ts", params.sinceIso);
    if (error) throw new Error(`price_history_points(load counts): ${error.message}`);

    for (const row of (data ?? []) as PriceHistoryCountRow[]) {
      const key = `${row.canonical_slug}::${row.variant_ref}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return counts;
}

export async function runProviderObservationVariantMetrics(opts: {
  provider: SupportedProvider;
  observationLimit?: number;
  providerSetId?: string | null;
}): Promise<VariantMetricsResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const observationLimit = parsePositiveInt(opts.observationLimit, DEFAULT_OBSERVATIONS_PER_RUN);
  const sinceIso = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  let firstError: string | null = null;
  let observationsScanned = 0;
  let observationsProcessed = 0;
  let observationsSkippedNoMatch = 0;
  let observationsSkippedNoPrice = 0;
  let observationsSkippedCondition = 0;
  let observationsSkippedNonSingle = 0;
  let metricsRowsUpserted = 0;
  let signalRowsUpdated = 0;
  let variantSignalsLatestRows = 0;
  const sampleRows: MetricsSample[] = [];
  let touchedVariantKeys: VariantSignalRefreshKey[] = [];

  const { data: runRow, error: runStartError } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: opts.provider.toLowerCase(),
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: {
        mode: "variant-metrics-write",
        provider: opts.provider,
        observationLimit,
        providerSetId: opts.providerSetId ?? null,
      },
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (runStartError) {
    throw new Error(`ingest_runs(start): ${runStartError.message}`);
  }
  const runId = runRow?.id ?? null;

  try {
    const candidateResult = await loadCandidateRows({
      provider: opts.provider,
      observationLimit,
      providerSetId: opts.providerSetId,
    });
    observationsScanned = candidateResult.scanned;

    const latestByVariant = new Map<string, CandidateRow>();
    for (const row of candidateResult.rows) {
      observationsProcessed += 1;
      if (row.observation.asset_type !== "single") {
        observationsSkippedNonSingle += 1;
        continue;
      }
      if (!row.mapping.canonical_slug || !row.mapping.printing_id) {
        observationsSkippedNoMatch += 1;
        continue;
      }
      const observedPrice = toFiniteNumber(row.observation.observed_price);
      if (observedPrice === null || observedPrice <= 0) {
        observationsSkippedNoPrice += 1;
        continue;
      }
      if (!shouldWriteRawForCondition(opts.provider, row.observation.normalized_condition)) {
        observationsSkippedCondition += 1;
        continue;
      }

      const variantKey = `${row.mapping.canonical_slug}::${row.mapping.printing_id}`;
      const existing = latestByVariant.get(variantKey) ?? null;
      if (!existing || existing.observation.observed_at < row.observation.observed_at) {
        latestByVariant.set(variantKey, row);
      }
    }

    const latestRows = [...latestByVariant.values()];
    const historyCounts = await loadHistoryPointCounts({
      provider: opts.provider,
      keys: latestRows.map((row) => ({
        canonicalSlug: String(row.mapping.canonical_slug),
        variantRef: buildRawVariantRef(String(row.mapping.printing_id)),
      })),
      sinceIso,
    });

    const writes: VariantMetricsWriteRow[] = [];
    const nowIso = new Date().toISOString();

    for (const row of latestRows) {
      const canonicalSlug = String(row.mapping.canonical_slug);
      const printingId = String(row.mapping.printing_id);
      const variantRef = buildRawVariantRef(printingId);
      const observedPrice = toFiniteNumber(row.observation.observed_price);
      const stagedHistoryPoints = parseHistoryPoints(row.observation.history_points_30d);
      const analytics = extractProviderAnalytics({
        provider: opts.provider,
        metadata: row.observation.metadata,
        historyPoints30d: stagedHistoryPoints,
        observedPrice,
      });
      const dbHistoryCount = historyCounts.get(`${canonicalSlug}::${variantRef}`) ?? 0;
      const stagedHistoryCount = Math.max(
        0,
        Number.isFinite(row.observation.history_points_30d_count ?? NaN)
          ? Number(row.observation.history_points_30d_count)
          : stagedHistoryPoints.length,
      );
      const historyPoints30d = Math.max(dbHistoryCount, stagedHistoryCount);

      writes.push({
        canonical_slug: canonicalSlug,
        printing_id: printingId,
        variant_ref: variantRef,
        provider: opts.provider,
        grade: "RAW",
        provider_trend_slope_7d: analytics.provider_trend_slope_7d,
        provider_cov_price_30d: analytics.provider_cov_price_30d,
        provider_price_relative_to_30d_range: analytics.provider_price_relative_to_30d_range,
        provider_price_changes_count_30d: analytics.provider_price_changes_count_30d,
        provider_as_of_ts: row.observation.observed_at,
        history_points_30d: historyPoints30d,
        updated_at: nowIso,
      });

      if (sampleRows.length < 25) {
        sampleRows.push({
          canonicalSlug,
          printingId,
          variantRef,
          providerSetId: row.observation.provider_set_id,
          providerCardId: row.observation.provider_card_id,
          providerVariantId: row.observation.provider_variant_id,
          providerTrendSlope7d: analytics.provider_trend_slope_7d,
          providerCovPrice30d: analytics.provider_cov_price_30d,
          providerPriceRelativeTo30dRange: analytics.provider_price_relative_to_30d_range,
          providerPriceChangesCount30d: analytics.provider_price_changes_count_30d,
          providerAsOfTs: row.observation.observed_at,
          historyPoints30d,
        });
      }
    }

    if (writes.length > 0) {
      touchedVariantKeys = writes.map((row) => ({
        canonical_slug: row.canonical_slug,
        variant_ref: row.variant_ref,
        provider: row.provider,
        grade: row.grade,
      }));
      const { data, error } = await supabase
        .from("variant_metrics")
        .upsert(writes, { onConflict: "canonical_slug,printing_id,provider,grade" })
        .select("id");
      if (error) throw new Error(`variant_metrics(upsert): ${error.message}`);
      metricsRowsUpserted = (data ?? []).length;

      const signalRefresh = await refreshDerivedSignalsForVariantKeys({
        provider: opts.provider,
        keys: touchedVariantKeys,
      });
      signalRowsUpdated = signalRefresh.signalRowsUpdated;
      variantSignalsLatestRows = signalRefresh.variantSignalsLatestRows;
      if (!signalRefresh.ok) {
        throw new Error(signalRefresh.firstError ?? "provider derived signals refresh failed");
      }
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  const result: VariantMetricsResult = {
    ok: firstError === null,
    job: JOB,
    provider: opts.provider,
    startedAt,
    endedAt: new Date().toISOString(),
    observationsRequested: observationLimit,
    observationsScanned,
    observationsProcessed,
    observationsSkippedNoMatch,
    observationsSkippedNoPrice,
    observationsSkippedCondition,
    observationsSkippedNonSingle,
    metricsRowsUpserted,
    signalRowsUpdated,
    variantSignalsLatestRows,
    firstError,
    sampleRows,
    touchedVariantKeys,
  };

  if (runId) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: result.ok,
        items_fetched: observationsProcessed,
        items_upserted: metricsRowsUpserted + signalRowsUpdated + variantSignalsLatestRows,
        items_failed: observationsSkippedNoMatch
          + observationsSkippedNoPrice
          + observationsSkippedCondition
          + observationsSkippedNonSingle
          + (firstError ? 1 : 0),
        ended_at: result.endedAt,
        meta: {
          mode: "variant-metrics-write",
          provider: opts.provider,
          observationLimit,
          providerSetId: opts.providerSetId ?? null,
          observationsScanned,
          observationsProcessed,
          observationsSkippedNoMatch,
          observationsSkippedNoPrice,
          observationsSkippedCondition,
          observationsSkippedNonSingle,
          metricsRowsUpserted,
          signalRowsUpdated,
          variantSignalsLatestRows,
          sampleRows,
          touchedVariantKeys: touchedVariantKeys.slice(0, 100),
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}
