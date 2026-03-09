import { dbAdmin } from "@/lib/db/admin";
import {
  buildProviderCardMapKey,
  loadProviderCardMapByKeys,
  type ProviderCardMapRow,
} from "@/lib/backfill/provider-card-map";
import { type VariantSignalRefreshKey } from "@/lib/backfill/provider-derived-signals";
import { buildProviderHistoryVariantRef } from "@/lib/identity/variant-ref.mjs";
import { convertToUsd } from "@/lib/pricing/fx";

const JOB = "provider_observation_timeseries";
const DEFAULT_OBSERVATIONS_PER_RUN = process.env.PROVIDER_OBSERVATION_TIMESERIES_OBSERVATIONS_PER_RUN
  ? parseInt(process.env.PROVIDER_OBSERVATION_TIMESERIES_OBSERVATIONS_PER_RUN, 10)
  : 300;
const SCAN_PAGE_SIZE = 100;

type SupportedProvider = "JUSTTCG" | "SCRYDEX";

type MatchScanRow = {
  provider_normalized_observation_id: string;
};

type PriceSnapshotStateRow = {
  provider_ref: string | null;
  observed_at: string;
};

type PriceHistoryStateRow = {
  variant_ref: string;
  ts: string;
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
  grade: "RAW";
  price_value: number;
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

function normalizeCurrency(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value) return value;
  return "USD";
}

function buildProviderRef(provider: SupportedProvider, providerVariantId: string): string {
  return `${provider.toLowerCase()}:${providerVariantId}`;
}

function buildHistoryVariantRef(row: CandidateRow, provider: SupportedProvider): string {
  return buildProviderHistoryVariantRef({
    printingId: row.mapping.printing_id,
    canonicalSlug: row.mapping.canonical_slug,
    provider,
    providerVariantId: row.observation.provider_variant_id,
  });
}

function shouldWriteRawForCondition(provider: SupportedProvider, condition: string | null | undefined): boolean {
  // Keep RAW market price comparable by using NM-only snapshots.
  // Scrydex observations now preserve the selected provider condition, but we
  // still only enforce the NM gate for JustTCG today.
  if (provider !== "JUSTTCG") return true;
  const normalized = String(condition ?? "").trim().toLowerCase();
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
      if (!shouldWriteRawForCondition(opts.provider, row.observation.normalized_condition)) {
        observationsSkippedCondition += 1;
        continue;
      }

      const providerRef = buildProviderRef(opts.provider, row.observation.provider_variant_id);
      const historyVariantRef = buildProviderHistoryVariantRef({
        printingId: row.mapping.printing_id,
        canonicalSlug: row.mapping.canonical_slug,
        provider: opts.provider,
        providerVariantId: row.observation.provider_variant_id,
      });
      const sourceCurrency = normalizeCurrency(row.observation.currency);
      const observedPriceUsd = convertToUsd(observedPrice, sourceCurrency);

      snapshotRows.push({
        canonical_slug: row.mapping.canonical_slug,
        printing_id: row.mapping.printing_id,
        grade: "RAW",
        price_value: observedPriceUsd,
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
      const { data, error } = await supabase
        .from("price_snapshots")
        .upsert(dedupedSnapshotRows, { onConflict: "provider,provider_ref" })
        .select("id");
      if (error) throw new Error(`price_snapshots(upsert): ${error.message}`);
      snapshotsUpserted = (data ?? []).length;
    }

    if (dedupedHistoryRows.length > 0) {
      const { data, error } = await supabase
        .from("price_history_points")
        .upsert(dedupedHistoryRows, { onConflict: "provider,variant_ref,ts,source_window" })
        .select("id");
      if (error) throw new Error(`price_history_points(upsert): ${error.message}`);
      historyPointsUpserted = (data ?? []).length;
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

export type { SupportedProvider };
