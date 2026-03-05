import { dbAdmin } from "@/lib/db/admin";
import { convertToUsd } from "@/lib/pricing/fx";

const JOB = "provider_observation_timeseries";
const DEFAULT_OBSERVATIONS_PER_RUN = process.env.PROVIDER_OBSERVATION_TIMESERIES_OBSERVATIONS_PER_RUN
  ? parseInt(process.env.PROVIDER_OBSERVATION_TIMESERIES_OBSERVATIONS_PER_RUN, 10)
  : 300;
const SCAN_PAGE_SIZE = 100;

type SupportedProvider = "JUSTTCG" | "POKEMON_TCG_API";

type MatchScanRow = {
  provider_normalized_observation_id: string;
};

type MatchRow = {
  provider_normalized_observation_id: string;
  provider: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  canonical_slug: string | null;
  printing_id: string | null;
  match_status: "MATCHED" | "UNMATCHED";
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
};

type CandidateRow = {
  match: MatchRow;
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
  source_window: "snapshot";
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
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeCurrency(raw: string | null | undefined, provider: SupportedProvider): string {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value) return value;
  return provider === "POKEMON_TCG_API" ? "EUR" : "USD";
}

function buildProviderRef(provider: SupportedProvider, providerVariantId: string): string {
  return `${provider.toLowerCase()}:${providerVariantId}`;
}

function buildHistoryVariantRef(match: MatchRow): string {
  if (match.printing_id) return `${match.printing_id}::RAW::${match.provider_variant_id}`;
  if (match.canonical_slug) return `${match.canonical_slug}::RAW::${match.provider_variant_id}`;
  return `${match.provider.toLowerCase()}:${match.provider_variant_id}::RAW`;
}

function shouldWriteRawForCondition(provider: SupportedProvider, condition: string | null | undefined): boolean {
  // Keep RAW market price comparable by using NM-only snapshots.
  // PokemonTCG API observations are normalized as NM by design.
  if (provider !== "JUSTTCG") return true;
  const normalized = String(condition ?? "").trim().toLowerCase();
  return normalized === "nm" || normalized === "mint";
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
      .select("provider_normalized_observation_id, provider, provider_set_id, provider_card_id, provider_variant_id, canonical_slug, printing_id, match_status")
      .eq("provider", params.provider)
      .eq("provider_normalized_observation_id", params.observationId)
      .eq("match_status", "MATCHED");

    if (params.providerSetId) {
      matchQuery = matchQuery.eq("provider_set_id", params.providerSetId);
    }

    const { data: matchData, error: matchError } = await matchQuery.maybeSingle<MatchRow>();
    if (matchError) throw new Error(`provider_observation_matches(load by observationId): ${matchError.message}`);
    if (!matchData) return { rows: [], scanned: 0, skippedAlreadyWritten: 0 };

      const { data: obsData, error: obsError } = await supabase
        .from("provider_normalized_observations")
        .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_condition, observed_price, currency, observed_at, variant_ref")
        .eq("id", matchData.provider_normalized_observation_id)
        .eq("provider", params.provider)
        .maybeSingle<ObservationRow>();
    if (obsError) throw new Error(`provider_normalized_observations(load by observationId): ${obsError.message}`);
    if (!obsData) return { rows: [], scanned: 1, skippedAlreadyWritten: 0 };

    return {
      rows: [{ match: matchData, observation: obsData }],
      scanned: 1,
      skippedAlreadyWritten: 0,
    };
  }

  const selected: CandidateRow[] = [];
  let scanned = 0;
  const skippedAlreadyWritten = 0;

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

    const [{ data: matchRows, error: matchLoadError }, { data: observationRows, error: obsLoadError }] = await Promise.all([
      supabase
        .from("provider_observation_matches")
        .select("provider_normalized_observation_id, provider, provider_set_id, provider_card_id, provider_variant_id, canonical_slug, printing_id, match_status")
        .in("provider_normalized_observation_id", selectedIds)
        .eq("provider", params.provider)
        .eq("match_status", "MATCHED"),
      supabase
        .from("provider_normalized_observations")
        .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_condition, observed_price, currency, observed_at, variant_ref")
        .in("id", selectedIds)
        .eq("provider", params.provider),
    ]);
    if (matchLoadError) throw new Error(`provider_observation_matches(load selected): ${matchLoadError.message}`);
    if (obsLoadError) throw new Error(`provider_normalized_observations(load selected): ${obsLoadError.message}`);

    const matchByObservationId = new Map<string, MatchRow>();
    for (const row of (matchRows ?? []) as MatchRow[]) {
      matchByObservationId.set(row.provider_normalized_observation_id, row);
    }
    const obsById = new Map<string, ObservationRow>();
    for (const row of (observationRows ?? []) as ObservationRow[]) {
      obsById.set(row.id, row);
    }

    for (const id of selectedIds) {
      const match = matchByObservationId.get(id);
      const observation = obsById.get(id);
      if (!match || !observation) continue;
      selected.push({ match, observation });
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
      if (!row.match.canonical_slug) {
        observationsSkippedNoCanonical += 1;
        continue;
      }
      if (!shouldWriteRawForCondition(opts.provider, row.observation.normalized_condition)) {
        observationsSkippedCondition += 1;
        continue;
      }

      const providerRef = buildProviderRef(opts.provider, row.match.provider_variant_id);
      const historyVariantRef = buildHistoryVariantRef(row.match);
      const sourceCurrency = normalizeCurrency(row.observation.currency, opts.provider);
      const observedPriceUsd = convertToUsd(observedPrice, sourceCurrency);

      snapshotRows.push({
        canonical_slug: row.match.canonical_slug,
        printing_id: row.match.printing_id,
        grade: "RAW",
        price_value: observedPriceUsd,
        currency: "USD",
        provider: opts.provider,
        provider_ref: providerRef,
        ingest_id: null,
        observed_at: row.observation.observed_at,
      });

      historyRows.push({
        canonical_slug: row.match.canonical_slug,
        variant_ref: historyVariantRef,
        provider: opts.provider,
        ts: row.observation.observed_at,
        price: observedPriceUsd,
        currency: "USD",
        source_window: "snapshot",
      });

      if (sampleWrites.length < 25) {
        sampleWrites.push({
          observationId: row.observation.id,
          providerSetId: row.observation.provider_set_id,
          providerCardId: row.observation.provider_card_id,
          providerVariantId: row.observation.provider_variant_id,
          canonicalSlug: row.match.canonical_slug,
          printingId: row.match.printing_id,
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
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}

export type { SupportedProvider };
