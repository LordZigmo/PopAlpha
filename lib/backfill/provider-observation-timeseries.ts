import { dbAdmin } from "@/lib/db/admin";
import {
  buildProviderCardMapKey,
  loadProviderCardMapByKeys,
  type ProviderCardMapRow,
} from "@/lib/backfill/provider-card-map";
import {
  isRetryableSupabaseWriteErrorMessage,
  retrySupabaseWriteOperation,
} from "@/lib/backfill/supabase-write-retry";
import type { AnalyticsPipelineProvider } from "@/lib/backfill/provider-registry";
import { type VariantSignalRefreshKey } from "@/lib/backfill/provider-derived-signals";
import { buildProviderHistoryVariantRef } from "@/lib/identity/variant-ref.mjs";
import { convertToUsd } from "@/lib/pricing/fx";

const JOB = "provider_observation_timeseries";
const DEFAULT_OBSERVATIONS_PER_RUN = process.env.PROVIDER_OBSERVATION_TIMESERIES_OBSERVATIONS_PER_RUN
  ? parseInt(process.env.PROVIDER_OBSERVATION_TIMESERIES_OBSERVATIONS_PER_RUN, 10)
  : 300;
const SCAN_PAGE_SIZE = 100;
const STALE_DELETE_PROVIDER_REF_CHUNK_SIZE = 100;
const STALE_DELETE_VARIANT_FILTER_CHUNK_SIZE = 20;

export type SupportedProvider = AnalyticsPipelineProvider;

type MatchScanRow = {
  provider_normalized_observation_id: string;
};

type PriceSnapshotStateRow = {
  provider_ref: string | null;
  observed_at: string;
};

type CleanupSnapshotRow = {
  provider_ref: string | null;
  canonical_slug: string | null;
  printing_id: string | null;
};

type PriceHistoryStateRow = {
  variant_ref: string;
  ts: string;
};

type CleanupHistoryVariantRefRow = {
  variant_ref: string | null;
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
  variant_ref: string;
  history_points_30d?: Array<{ ts?: string; price?: number; currency?: string }> | null;
  metadata?: Record<string, unknown> | null;
};

type CandidateRow = {
  mapping: ProviderCardMapRow;
  observation: ObservationRow;
};

type PriceSnapshotWriteRow = {
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
  price_value: number;
  low_value: number | null;
  high_value: number | null;
  sample_count: number | null;
  currency: string;
  provider: SupportedProvider;
  provider_ref: string;
  ingest_id: null;
  observed_at: string;
};

type PriceHistoryWriteRow = {
  canonical_slug: string;
  variant_ref: string;
  provider: SupportedProvider;
  ts: string;
  price: number;
  currency: string;
  source_window: string;
};

type TimeseriesSample = {
  observationId: string;
  providerSetId: string | null;
  providerCardId: string;
  providerVariantId: string;
  canonicalSlug: string | null;
  printingId: string | null;
  providerRef: string;
  historyVariantRef: string;
  observedPrice: number;
  observedPriceUsd: number;
  sourceCurrency: string;
  observedAt: string;
};

type TimeseriesResult = {
  ok: boolean;
  job: string;
  provider: SupportedProvider;
  startedAt: string;
  endedAt: string;
  observationsRequested: number;
  observationsScanned: number;
  observationsProcessed: number;
  observationsSkippedAlreadyWritten: number;
  observationsSkippedNoPrice: number;
  observationsSkippedNoCanonical: number;
  observationsSkippedCondition: number;
  snapshotsUpserted: number;
  historyPointsUpserted: number;
  firstError: string | null;
  sampleWrites: TimeseriesSample[];
  touchedVariantKeys: VariantSignalRefreshKey[];
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function normalizeCurrency(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value) return value;
  return "USD";
}

function buildProviderRef(provider: SupportedProvider, providerVariantId: string): string {
  return `${provider.toLowerCase()}:${providerVariantId}`;
}

function buildStaleVariantRefLikeFilter(providerVariantId: string): string {
  return `variant_ref.like.%::${providerVariantId}::RAW`;
}

function extractProviderVariantIdFromProviderRef(provider: SupportedProvider, providerRef: string): string | null {
  const normalized = String(providerRef ?? "").trim();
  const prefix = `${provider.toLowerCase()}:`;
  if (!normalized.startsWith(prefix)) return null;
  const providerVariantId = normalized.slice(prefix.length).trim();
  return providerVariantId || null;
}

function extractProviderVariantIdFromVariantRef(variantRef: string): string | null {
  const normalized = String(variantRef ?? "").trim();
  if (!normalized) return null;
  const parts = normalized.split("::");
  if (parts.length < 3) return null;
  const providerVariantId = parts.at(-2)?.trim();
  return providerVariantId || null;
}

function buildHistoryVariantRef(row: CandidateRow, provider: SupportedProvider): string {
  return buildProviderHistoryVariantRef({
    printingId: row.mapping.printing_id,
    canonicalSlug: row.mapping.canonical_slug,
    provider,
    providerVariantId: row.observation.provider_variant_id,
  });
}

function shouldWriteObservation(_provider: SupportedProvider, observation: { normalized_condition?: string | null; metadata?: Record<string, unknown> | null }): boolean {
  const grade = String(observation.metadata?.grade ?? "RAW").trim();
  // Graded observations always write — their grade is the primary qualifier.
  if (grade && grade !== "RAW") return true;
  // Raw observations require Near Mint or Mint condition.
  const normalized = String(observation.normalized_condition ?? "").trim().toLowerCase();
  return normalized === "nm" || normalized === "mint";
}

function parseTrendAnchorPoints(
  metadata: Record<string, unknown> | null | undefined,
): Array<{
  ts: string;
  price: number;
  currency: string;
  sourceWindow: string;
}> {
  const raw = metadata?.providerTrendAnchorPoints;
  if (!Array.isArray(raw)) return [];

  const anchors: Array<{
    ts: string;
    price: number;
    currency: string;
    sourceWindow: string;
  }> = [];

  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const ts = String(row.ts ?? "").trim();
    const price = typeof row.price === "number" ? row.price : Number.parseFloat(String(row.price ?? ""));
    const currency = normalizeCurrency(String(row.currency ?? "USD"));
    const sourceWindow = String(row.sourceWindow ?? "").trim();
    if (!ts || !Number.isFinite(price) || price <= 0 || !sourceWindow) continue;
    anchors.push({ ts, price, currency, sourceWindow });
  }

  return anchors;
}

async function loadExistingWriteState(
  provider: SupportedProvider,
  rows: CandidateRow[],
): Promise<{
  snapshotObservedAtByProviderRef: Map<string, string>;
  writtenSnapshotHistoryKeys: Set<string>;
}> {
  const supabase = dbAdmin();
  const providerRefs = [...new Set(
    rows
      .map((row) => buildProviderRef(provider, row.observation.provider_variant_id))
      .filter(Boolean),
  )];
  const historyVariantRefs = [...new Set(
    rows
      .map((row) => buildHistoryVariantRef(row, provider))
      .filter(Boolean),
  )];
  const observedAts = [...new Set(
    rows
      .map((row) => row.observation.observed_at)
      .filter(Boolean),
  )];

  const snapshotObservedAtByProviderRef = new Map<string, string>();
  const writtenSnapshotHistoryKeys = new Set<string>();

  if (providerRefs.length > 0) {
    const { data, error } = await supabase
      .from("price_snapshots")
      .select("provider_ref, observed_at")
      .eq("provider", provider)
      .in("provider_ref", providerRefs);
    if (error) throw new Error(`price_snapshots(load existing): ${error.message}`);

    for (const row of (data ?? []) as PriceSnapshotStateRow[]) {
      const providerRef = String(row.provider_ref ?? "").trim();
      if (!providerRef || !row.observed_at) continue;
      const existingObservedAt = snapshotObservedAtByProviderRef.get(providerRef) ?? null;
      if (!existingObservedAt || existingObservedAt < row.observed_at) {
        snapshotObservedAtByProviderRef.set(providerRef, row.observed_at);
      }
    }
  }

  if (historyVariantRefs.length > 0 && observedAts.length > 0) {
    const { data, error } = await supabase
      .from("price_history_points")
      .select("variant_ref, ts")
      .eq("provider", provider)
      .eq("source_window", "snapshot")
      .in("variant_ref", historyVariantRefs)
      .in("ts", observedAts);
    if (error) throw new Error(`price_history_points(load existing): ${error.message}`);

    for (const row of (data ?? []) as PriceHistoryStateRow[]) {
      const variantRef = String(row.variant_ref ?? "").trim();
      const ts = String(row.ts ?? "").trim();
      if (!variantRef || !ts) continue;
      writtenSnapshotHistoryKeys.add(`${variantRef}::${ts}`);
    }
  }

  return {
    snapshotObservedAtByProviderRef,
    writtenSnapshotHistoryKeys,
  };
}

async function loadCandidateRows(params: {
  provider: SupportedProvider;
  observationLimit: number;
  providerSetId?: string | null;
  observationId?: string | null;
  force?: boolean;
}): Promise<{
  rows: CandidateRow[];
  scanned: number;
  skippedAlreadyWritten: number;
}> {
  const supabase = dbAdmin();

  if (params.observationId) {
    let matchQuery = supabase
      .from("provider_observation_matches")
      .select("provider_normalized_observation_id")
      .eq("provider", params.provider)
      .eq("provider_normalized_observation_id", params.observationId)
      .eq("match_status", "MATCHED");

    if (params.providerSetId) {
      matchQuery = matchQuery.eq("provider_set_id", params.providerSetId);
    }

    const { data: matchData, error: matchError } = await matchQuery.maybeSingle<MatchScanRow>();
    if (matchError) throw new Error(`provider_observation_matches(load by observationId): ${matchError.message}`);
    if (!matchData) return { rows: [], scanned: 0, skippedAlreadyWritten: 0 };

    const { data: obsData, error: obsError } = await supabase
      .from("provider_normalized_observations")
      .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_condition, observed_price, currency, observed_at, variant_ref, history_points_30d, metadata")
      .eq("id", matchData.provider_normalized_observation_id)
      .eq("provider", params.provider)
      .maybeSingle<ObservationRow>();
    if (obsError) throw new Error(`provider_normalized_observations(load by observationId): ${obsError.message}`);
    if (!obsData) return { rows: [], scanned: 1, skippedAlreadyWritten: 0 };

    const providerKey = buildProviderCardMapKey(obsData.provider_card_id, obsData.provider_variant_id);
    const providerCardMapByKey = await loadProviderCardMapByKeys({
      provider: params.provider,
      providerKeys: [providerKey],
    });
    const mapping = providerCardMapByKey.get(providerKey) ?? null;
    if (!mapping || mapping.mapping_status !== "MATCHED" || !mapping.canonical_slug) {
      return { rows: [], scanned: 1, skippedAlreadyWritten: 0 };
    }

    return {
      rows: [{ mapping, observation: obsData }],
      scanned: 1,
      skippedAlreadyWritten: 0,
    };
  }

  const selected: CandidateRow[] = [];
  let scanned = 0;
  let skippedAlreadyWritten = 0;

  for (let from = 0; selected.length < params.observationLimit; from += SCAN_PAGE_SIZE) {
    const { data, error } = await supabase.rpc("scan_matched_observations", {
      p_provider: params.provider,
      p_provider_set_id: params.providerSetId ?? null,
      p_limit: SCAN_PAGE_SIZE,
      p_offset: from,
    });
    if (error) throw new Error(`provider_observation_matches(scan): ${error.message}`);

    const scanRows = (data ?? []) as MatchScanRow[];
    if (scanRows.length === 0) break;
    scanned += scanRows.length;

    const selectedIds: string[] = [];
    for (const row of scanRows) {
      selectedIds.push(row.provider_normalized_observation_id);
      if (selected.length + selectedIds.length >= params.observationLimit) break;
    }

    if (selectedIds.length === 0) continue;

    const [{ data: observationRows, error: obsLoadError }] = await Promise.all([
      supabase
        .from("provider_normalized_observations")
        .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_condition, observed_price, currency, observed_at, variant_ref, history_points_30d, metadata")
        .in("id", selectedIds)
        .eq("provider", params.provider),
    ]);
    if (obsLoadError) throw new Error(`provider_normalized_observations(load selected): ${obsLoadError.message}`);

    const obsById = new Map<string, ObservationRow>();
    for (const row of (observationRows ?? []) as ObservationRow[]) {
      obsById.set(row.id, row);
    }
    const providerCardMapByKey = await loadProviderCardMapByKeys({
      provider: params.provider,
      providerKeys: (observationRows ?? []).map((row) =>
        buildProviderCardMapKey(
          String((row as ObservationRow).provider_card_id),
          String((row as ObservationRow).provider_variant_id),
        )),
    });

    const candidateRows: CandidateRow[] = [];
    for (const id of selectedIds) {
      const observation = obsById.get(id);
      if (!observation) continue;
      const providerKey = buildProviderCardMapKey(observation.provider_card_id, observation.provider_variant_id);
      const mapping = providerCardMapByKey.get(providerKey) ?? null;
      if (!mapping || mapping.mapping_status !== "MATCHED" || !mapping.canonical_slug) continue;
      candidateRows.push({ mapping, observation });
    }

    let existingWriteState: Awaited<ReturnType<typeof loadExistingWriteState>> | null = null;
    if (!params.force && candidateRows.length > 0) {
      existingWriteState = await loadExistingWriteState(params.provider, candidateRows);
    }

    for (const row of candidateRows) {
      if (!params.force && existingWriteState) {
        const providerRef = buildProviderRef(params.provider, row.observation.provider_variant_id);
        const historyVariantRef = buildHistoryVariantRef(row, params.provider);
        const latestSnapshotObservedAt = existingWriteState.snapshotObservedAtByProviderRef.get(providerRef) ?? null;
        const historySnapshotKey = `${historyVariantRef}::${row.observation.observed_at}`;
        const snapshotCurrent = latestSnapshotObservedAt !== null
          && latestSnapshotObservedAt >= row.observation.observed_at;
        const historyCurrent = existingWriteState.writtenSnapshotHistoryKeys.has(historySnapshotKey);
        if (snapshotCurrent && historyCurrent) {
          skippedAlreadyWritten += 1;
          continue;
        }
      }

      selected.push(row);
      if (selected.length >= params.observationLimit) break;
    }
  }

  return { rows: selected, scanned, skippedAlreadyWritten };
}

async function cleanupStaleProviderVariantWrites(params: {
  provider: SupportedProvider;
  providerSetId?: string | null;
  observationId?: string | null;
  updatedSinceIso?: string | null;
}): Promise<void> {
  const supabase = dbAdmin();
  const staleProviderVariantIds = new Set<string>();

  if (params.observationId) {
    const { data: observation, error: observationError } = await supabase
      .from("provider_normalized_observations")
      .select("provider_card_id, provider_variant_id")
      .eq("id", params.observationId)
      .eq("provider", params.provider)
      .maybeSingle<{ provider_card_id: string; provider_variant_id: string }>();
    if (observationError) {
      throw new Error(`provider_normalized_observations(load cleanup observation): ${observationError.message}`);
    }
    if (observation?.provider_card_id && observation?.provider_variant_id) {
      const providerKey = buildProviderCardMapKey(observation.provider_card_id, observation.provider_variant_id);
      const providerCardMapByKey = await loadProviderCardMapByKeys({
        provider: params.provider,
        providerKeys: [providerKey],
      });
      const mapping = providerCardMapByKey.get(providerKey) ?? null;
      if (!mapping || mapping.mapping_status !== "MATCHED") {
        staleProviderVariantIds.add(observation.provider_variant_id);
      }
    }
  }

  if (params.providerSetId) {
    let query = supabase
      .from("provider_card_map")
      .select("provider_variant_id")
      .eq("provider", params.provider)
      .eq("provider_set_id", params.providerSetId)
      .eq("mapping_status", "UNMATCHED");

    if (params.updatedSinceIso) {
      query = query.gte("updated_at", params.updatedSinceIso);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`provider_card_map(load stale variants): ${error.message}`);
    }
    for (const row of (data ?? []) as Array<{ provider_variant_id: string | null }>) {
      const providerVariantId = String(row.provider_variant_id ?? "").trim();
      if (providerVariantId) staleProviderVariantIds.add(providerVariantId);
    }
  }

  const providerVariantIds = [...staleProviderVariantIds];
  if (providerVariantIds.length === 0) return;

  const providerRefs = providerVariantIds.map((providerVariantId) => buildProviderRef(params.provider, providerVariantId));
  const { data: cleanupSnapshotRows, error: cleanupSnapshotError } = await supabase
    .from("price_snapshots")
    .select("provider_ref, canonical_slug, printing_id")
    .eq("provider", params.provider)
    .in("provider_ref", providerRefs);
  if (cleanupSnapshotError) {
    throw new Error(`price_snapshots(load stale history refs): ${cleanupSnapshotError.message}`);
  }

  const exactHistoryVariantRefs = new Set<string>();
  const providerVariantIdsWithExactRefs = new Set<string>();
  for (const row of (cleanupSnapshotRows ?? []) as CleanupSnapshotRow[]) {
    const providerRef = String(row.provider_ref ?? "").trim();
    const canonicalSlug = String(row.canonical_slug ?? "").trim();
    const providerVariantId = providerRef
      ? extractProviderVariantIdFromProviderRef(params.provider, providerRef)
      : null;
    if (!providerVariantId || !canonicalSlug) continue;
    exactHistoryVariantRefs.add(buildProviderHistoryVariantRef({
      printingId: row.printing_id,
      canonicalSlug,
      provider: params.provider,
      providerVariantId,
    }));
    providerVariantIdsWithExactRefs.add(providerVariantId);
  }

  const providerRefChunks = chunkValues(providerRefs, STALE_DELETE_PROVIDER_REF_CHUNK_SIZE);
  for (let chunkIndex = 0; chunkIndex < providerRefChunks.length; chunkIndex += 1) {
    const providerRefChunk = providerRefChunks[chunkIndex];
    await retrySupabaseWriteOperation(
      `price_snapshots(delete stale chunk ${chunkIndex + 1}/${providerRefChunks.length})`,
      async () => {
        const { error } = await supabase
          .from("price_snapshots")
          .delete()
          .eq("provider", params.provider)
          .in("provider_ref", providerRefChunk);
        if (error) throw new Error(error.message);
      },
    );
  }

  const exactHistoryVariantRefChunks = chunkValues([...exactHistoryVariantRefs], STALE_DELETE_PROVIDER_REF_CHUNK_SIZE);
  for (let chunkIndex = 0; chunkIndex < exactHistoryVariantRefChunks.length; chunkIndex += 1) {
    const historyVariantRefChunk = exactHistoryVariantRefChunks[chunkIndex];
    await retrySupabaseWriteOperation(
      `price_history_points(delete stale exact chunk ${chunkIndex + 1}/${exactHistoryVariantRefChunks.length})`,
      async () => {
        const { error } = await supabase
          .from("price_history_points")
          .delete()
          .eq("provider", params.provider)
          .in("variant_ref", historyVariantRefChunk);
        if (error) throw new Error(error.message);
      },
    );
  }

  const unresolvedProviderVariantIds = providerVariantIds.filter(
    (providerVariantId) => !providerVariantIdsWithExactRefs.has(providerVariantId),
  );
  const providerVariantIdChunks = chunkValues(unresolvedProviderVariantIds, STALE_DELETE_VARIANT_FILTER_CHUNK_SIZE);
  for (let chunkIndex = 0; chunkIndex < providerVariantIdChunks.length; chunkIndex += 1) {
    const providerVariantIdChunk = providerVariantIdChunks[chunkIndex];
    const resolvedVariantRefs = new Set<string>();
    const resolvedProviderVariantIds = new Set<string>();
    const lookupOrFilter = providerVariantIdChunk
      .map((providerVariantId) => buildStaleVariantRefLikeFilter(providerVariantId))
      .join(",");
    const { data: historyVariantRefRows, error: historyVariantRefLookupError } = await supabase
      .from("price_history_points")
      .select("variant_ref")
      .eq("provider", params.provider)
      .or(lookupOrFilter);
    if (historyVariantRefLookupError) {
      throw new Error(`price_history_points(load stale variant refs): ${historyVariantRefLookupError.message}`);
    }

    for (const row of (historyVariantRefRows ?? []) as CleanupHistoryVariantRefRow[]) {
      const variantRef = String(row.variant_ref ?? "").trim();
      const resolvedProviderVariantId = extractProviderVariantIdFromVariantRef(variantRef);
      if (!variantRef || !resolvedProviderVariantId) continue;
      resolvedVariantRefs.add(variantRef);
      resolvedProviderVariantIds.add(resolvedProviderVariantId);
    }

    const resolvedVariantRefChunks = chunkValues([...resolvedVariantRefs], STALE_DELETE_PROVIDER_REF_CHUNK_SIZE);
    for (let resolvedChunkIndex = 0; resolvedChunkIndex < resolvedVariantRefChunks.length; resolvedChunkIndex += 1) {
      const resolvedVariantRefChunk = resolvedVariantRefChunks[resolvedChunkIndex];
      await retrySupabaseWriteOperation(
        `price_history_points(delete stale resolved chunk ${chunkIndex + 1}.${resolvedChunkIndex + 1}/${providerVariantIdChunks.length}.${resolvedVariantRefChunks.length})`,
        async () => {
          const { error } = await supabase
            .from("price_history_points")
            .delete()
            .eq("provider", params.provider)
            .in("variant_ref", resolvedVariantRefChunk);
          if (error) throw new Error(error.message);
        },
      );
    }

    const fallbackProviderVariantIds = providerVariantIdChunk.filter(
      (providerVariantId) => !resolvedProviderVariantIds.has(providerVariantId),
    );
    if (fallbackProviderVariantIds.length === 0) continue;
    const fallbackOrFilter = fallbackProviderVariantIds
      .map((providerVariantId) => buildStaleVariantRefLikeFilter(providerVariantId))
      .join(",");
    await retrySupabaseWriteOperation(
      `price_history_points(delete stale chunk ${chunkIndex + 1}/${providerVariantIdChunks.length})`,
      async () => {
        const { error } = await supabase
          .from("price_history_points")
          .delete()
          .eq("provider", params.provider)
          .or(fallbackOrFilter);
        if (error) throw new Error(error.message);
      },
    );
  }
}

export async function runProviderObservationTimeseries(opts: {
  provider: SupportedProvider;
  observationLimit?: number;
  providerSetId?: string | null;
  observationId?: string | null;
  force?: boolean;
}): Promise<TimeseriesResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const observationLimit = parsePositiveInt(opts.observationLimit, DEFAULT_OBSERVATIONS_PER_RUN);

  let firstError: string | null = null;
  let observationsScanned = 0;
  let observationsProcessed = 0;
  let observationsSkippedAlreadyWritten = 0;
  let observationsSkippedNoPrice = 0;
  let observationsSkippedNoCanonical = 0;
  let observationsSkippedCondition = 0;
  let snapshotsUpserted = 0;
  let historyPointsUpserted = 0;
  const sampleWrites: TimeseriesSample[] = [];
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
        mode: "timeseries-write",
        provider: opts.provider,
        observationLimit,
        providerSetId: opts.providerSetId ?? null,
        observationId: opts.observationId ?? null,
        force: opts.force === true,
      },
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (runStartError) {
    throw new Error(`ingest_runs(start): ${runStartError.message}`);
  }
  const runId = runRow?.id ?? null;

  try {
    const cleanupScopeIso = new Date(Date.now() - (12 * 60 * 60 * 1000)).toISOString();
    try {
      await cleanupStaleProviderVariantWrites({
        provider: opts.provider,
        providerSetId: opts.providerSetId,
        observationId: opts.observationId,
        updatedSinceIso: cleanupScopeIso,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const scopedCleanup = Boolean(opts.providerSetId || opts.observationId);
      if (!scopedCleanup || !isRetryableSupabaseWriteErrorMessage(message)) {
        throw error;
      }
      console.warn(
        `[provider_observation_timeseries] stale cleanup skipped for ${opts.provider}:${opts.providerSetId ?? opts.observationId}: ${message}`,
      );
    }

    const candidateResult = await loadCandidateRows({
      provider: opts.provider,
      observationLimit,
      providerSetId: opts.providerSetId,
      observationId: opts.observationId,
      force: opts.force,
    });

    observationsScanned = candidateResult.scanned;
    observationsSkippedAlreadyWritten = candidateResult.skippedAlreadyWritten;

    const snapshotRows: PriceSnapshotWriteRow[] = [];
    const historyRows: PriceHistoryWriteRow[] = [];

    for (const row of candidateResult.rows) {
      observationsProcessed += 1;
      const observedPrice = row.observation.observed_price;
      if (typeof observedPrice !== "number" || !Number.isFinite(observedPrice) || observedPrice <= 0) {
        observationsSkippedNoPrice += 1;
        continue;
      }
      if (!row.mapping.canonical_slug) {
        observationsSkippedNoCanonical += 1;
        continue;
      }
      if (!shouldWriteObservation(opts.provider, row.observation)) {
        observationsSkippedCondition += 1;
        continue;
      }

      const observationGrade = String(row.observation.metadata?.grade ?? "RAW").trim();
      const providerRef = buildProviderRef(opts.provider, row.observation.provider_variant_id);
      const historyVariantRef = buildProviderHistoryVariantRef({
        printingId: row.mapping.printing_id,
        canonicalSlug: row.mapping.canonical_slug,
        provider: opts.provider,
        providerVariantId: row.observation.provider_variant_id,
      });
      const sourceCurrency = normalizeCurrency(row.observation.currency);
      const observedPriceUsd = convertToUsd(observedPrice, sourceCurrency);

      const metaLow = row.observation.metadata?.lowPrice;
      const metaHigh = row.observation.metadata?.highPrice;
      snapshotRows.push({
        canonical_slug: row.mapping.canonical_slug,
        printing_id: row.mapping.printing_id,
        grade: observationGrade,
        price_value: observedPriceUsd,
        low_value: typeof metaLow === "number" && Number.isFinite(metaLow) && metaLow > 0
          ? convertToUsd(metaLow, sourceCurrency) : null,
        high_value: typeof metaHigh === "number" && Number.isFinite(metaHigh) && metaHigh > 0
          ? convertToUsd(metaHigh, sourceCurrency) : null,
        sample_count: null,
        currency: "USD",
        provider: opts.provider,
        provider_ref: providerRef,
        ingest_id: null,
        observed_at: row.observation.observed_at,
      });

      historyRows.push({
        canonical_slug: row.mapping.canonical_slug,
        variant_ref: historyVariantRef,
        provider: opts.provider,
        ts: row.observation.observed_at,
        price: observedPriceUsd,
        currency: "USD",
        source_window: "snapshot",
      });

      for (const point of parseTrendAnchorPoints(row.observation.metadata)) {
        const anchorPriceUsd = convertToUsd(point.price, point.currency);
        historyRows.push({
          canonical_slug: row.mapping.canonical_slug,
          variant_ref: historyVariantRef,
          provider: opts.provider,
          ts: point.ts,
          price: anchorPriceUsd,
          currency: "USD",
          source_window: point.sourceWindow,
        });
      }

      if (sampleWrites.length < 25) {
        sampleWrites.push({
          observationId: row.observation.id,
          providerSetId: row.observation.provider_set_id,
          providerCardId: row.observation.provider_card_id,
          providerVariantId: row.observation.provider_variant_id,
          canonicalSlug: row.mapping.canonical_slug,
          printingId: row.mapping.printing_id,
          providerRef,
          historyVariantRef,
          observedPrice,
          observedPriceUsd,
          sourceCurrency,
          observedAt: row.observation.observed_at,
        });
      }
    }

    const dedupedSnapshotsByKey = new Map<string, PriceSnapshotWriteRow>();
    for (const row of snapshotRows) {
      const key = `${row.provider}|${row.provider_ref}`;
      const existing = dedupedSnapshotsByKey.get(key);
      if (!existing || existing.observed_at < row.observed_at) {
        dedupedSnapshotsByKey.set(key, row);
      }
    }
    const dedupedHistoryByKey = new Map<string, PriceHistoryWriteRow>();
    for (const row of historyRows) {
      const key = `${row.provider}|${row.variant_ref}|${row.ts}|${row.source_window}`;
      if (!dedupedHistoryByKey.has(key)) dedupedHistoryByKey.set(key, row);
    }

    const dedupedSnapshotRows = [...dedupedSnapshotsByKey.values()];
    const dedupedHistoryRows = [...dedupedHistoryByKey.values()];
    touchedVariantKeys = dedupedHistoryRows.map((row) => ({
      canonical_slug: row.canonical_slug,
      variant_ref: row.variant_ref,
      provider: row.provider,
      grade: "RAW",
    }));

    if (dedupedSnapshotRows.length > 0) {
      const data = await retrySupabaseWriteOperation(
        "price_snapshots(upsert)",
        async () => {
          const { data, error } = await supabase
            .from("price_snapshots")
            .upsert(dedupedSnapshotRows, { onConflict: "provider,provider_ref" })
            .select("id");
          if (error) throw new Error(error.message);
          return (data ?? []) as Array<{ id: string }>;
        },
      );
      snapshotsUpserted = data.length;
    }

    if (dedupedHistoryRows.length > 0) {
      const data = await retrySupabaseWriteOperation(
        "price_history_points(upsert)",
        async () => {
          const { data, error } = await supabase
            .from("price_history_points")
            .upsert(dedupedHistoryRows, { onConflict: "provider,variant_ref,ts,source_window" })
            .select("id");
          if (error) throw new Error(error.message);
          return (data ?? []) as Array<{ id: string }>;
        },
      );
      historyPointsUpserted = data.length;
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  const endedAt = new Date().toISOString();
  const result: TimeseriesResult = {
    ok: firstError === null,
    job: JOB,
    provider: opts.provider,
    startedAt,
    endedAt,
    observationsRequested: observationLimit,
    observationsScanned,
    observationsProcessed,
    observationsSkippedAlreadyWritten,
    observationsSkippedNoPrice,
    observationsSkippedNoCanonical,
    observationsSkippedCondition,
    snapshotsUpserted,
    historyPointsUpserted,
    firstError,
    sampleWrites,
    touchedVariantKeys,
  };

  if (runId) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: result.ok,
        items_fetched: observationsProcessed,
        items_upserted: snapshotsUpserted + historyPointsUpserted,
        items_failed: observationsSkippedNoPrice + observationsSkippedNoCanonical + observationsSkippedCondition + (firstError ? 1 : 0),
        ended_at: endedAt,
        meta: {
          mode: "timeseries-write",
          provider: opts.provider,
          observationLimit,
          providerSetId: opts.providerSetId ?? null,
          observationId: opts.observationId ?? null,
          force: opts.force === true,
          observationsScanned,
          observationsProcessed,
          observationsSkippedAlreadyWritten,
          observationsSkippedNoPrice,
          observationsSkippedNoCanonical,
          observationsSkippedCondition,
          snapshotsUpserted,
          historyPointsUpserted,
          sampleWrites,
          touchedVariantKeys: touchedVariantKeys.slice(0, 100),
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}
