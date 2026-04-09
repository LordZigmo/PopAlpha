import { dbAdmin } from "@/lib/db/admin";
import {
  buildProviderCardMapKey,
  buildProviderCardMapUpsertRow,
  dedupeProviderCardMapUpsertRows,
  loadProviderCardMapByKeys,
  type ProviderCardMapRow,
  type ProviderCardMapUpsertRow,
} from "@/lib/backfill/provider-card-map";
import { loadProviderSetIndex } from "@/lib/backfill/provider-set-index";
import {
  loadHighValueStaleSetPriority,
  loadRecentSetConsistencyPriority,
} from "@/lib/backfill/set-priority";
import {
  hasScrydexSpecialVariantToken,
  normalizeScrydexStampToken,
  normalizeScrydexVariantToken,
} from "@/lib/backfill/scrydex-variant-semantics";

const PROVIDER = "SCRYDEX";
const JOB = "scrydex_normalized_match";
const DEFAULT_OBSERVATIONS_PER_RUN = process.env.SCRYDEX_MATCH_OBSERVATIONS_PER_RUN
  ? parseInt(process.env.SCRYDEX_MATCH_OBSERVATIONS_PER_RUN, 10)
  : process.env.POKEMONTCG_MATCH_OBSERVATIONS_PER_RUN
    ? parseInt(process.env.POKEMONTCG_MATCH_OBSERVATIONS_PER_RUN, 10)
    : 1200;
const UNMATCHED_RETRY_HOURS = process.env.SCRYDEX_UNMATCHED_RETRY_HOURS
  ? parseInt(process.env.SCRYDEX_UNMATCHED_RETRY_HOURS, 10)
  : 6;
const MIN_AUTO_MATCH_CONFIDENCE = process.env.SCRYDEX_MIN_AUTO_MATCH_CONFIDENCE
  ? Number.parseFloat(process.env.SCRYDEX_MIN_AUTO_MATCH_CONFIDENCE)
  : 0.9;
const DEFAULT_MATCH_MAX_RUNTIME_MS = process.env.SCRYDEX_MATCH_MAX_RUNTIME_MS
  ? parseInt(process.env.SCRYDEX_MATCH_MAX_RUNTIME_MS, 10)
  : 120000;
const DEFAULT_MATCH_MODE = process.env.SCRYDEX_MATCH_MODE?.trim().toLowerCase() === "backlog"
  ? "backlog"
  : "incremental";
const INCREMENTAL_RECENT_WINDOW_HOURS = process.env.SCRYDEX_MATCH_RECENT_WINDOW_HOURS
  ? parseInt(process.env.SCRYDEX_MATCH_RECENT_WINDOW_HOURS, 10)
  : 8;
const INCREMENTAL_MAX_SCAN_ROWS = process.env.SCRYDEX_MATCH_INCREMENTAL_MAX_SCAN_ROWS
  ? parseInt(process.env.SCRYDEX_MATCH_INCREMENTAL_MAX_SCAN_ROWS, 10)
  : 2500;
const INCREMENTAL_HOT_SET_LIMIT = process.env.SCRYDEX_MATCH_HOT_SET_LIMIT
  ? parseInt(process.env.SCRYDEX_MATCH_HOT_SET_LIMIT, 10)
  : 40;
const SCAN_PAGE_SIZE = 100;
const MATCH_UPSERT_BATCH_SIZE = 250;
const STARTED_RUN_STALE_MULTIPLIER = process.env.SCRYDEX_MATCH_STALE_RUN_MULTIPLIER
  ? parseInt(process.env.SCRYDEX_MATCH_STALE_RUN_MULTIPLIER, 10)
  : 3;
type ScanDirection = "newest" | "oldest";
type MatchMode = "incremental" | "backlog";

type ScanRow = {
  id: string;
  observed_at: string;
};

type ExistingMatchRow = {
  provider_normalized_observation_id: string;
  match_status: "MATCHED" | "UNMATCHED";
  updated_at: string | null;
};

type NormalizedObservationRow = {
  id: string;
  provider: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  asset_type: "single";
  normalized_card_number: string | null;
  normalized_finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
  normalized_edition: "UNLIMITED" | "FIRST_EDITION";
  normalized_stamp: string;
  normalized_language: string;
  observed_at: string;
};

type ProviderSetMapRow = {
  provider_set_id: string;
  canonical_set_code: string;
};

type PrintingRow = {
  id: string;
  canonical_slug: string;
  set_code: string | null;
  card_number: string;
  language: string;
  finish: string;
  edition: string;
  stamp: string | null;
};

type MatchWriteRow = {
  provider_normalized_observation_id: string;
  provider: string;
  asset_type: "single" | "sealed";
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  canonical_slug: string | null;
  printing_id: string | null;
  match_status: "MATCHED" | "UNMATCHED";
  match_type: string | null;
  match_confidence: number | null;
  match_reason: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
};

type MatchSample = {
  observationId: string;
  providerSetId: string | null;
  providerCardId: string;
  providerVariantId: string;
  assetType: "single" | "sealed";
  matchStatus: "MATCHED" | "UNMATCHED";
  printingId: string | null;
  canonicalSlug: string | null;
  matchType: string | null;
  matchReason: string | null;
};

type MatchResult = {
  ok: boolean;
  job: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  observationsRequested: number;
  observationsScanned: number;
  observationsProcessed: number;
  observationsSkippedAlreadyMatched: number;
  matchedCount: number;
  unmatchedCount: number;
  singlesMatched: number;
  sealedMatched: number;
  firstError: string | null;
  sampleMatches: MatchSample[];
};

type MatchedDecision = {
  matched: true;
  printing: PrintingRow;
  matchType: string;
  confidence: number;
  metadata: Record<string, unknown>;
};

type UnmatchedDecision = {
  matched: false;
  reason: string;
  metadata: Record<string, unknown>;
};

type MatchDecision = MatchedDecision | UnmatchedDecision;

function buildMatchedRowFromProviderCardMap(
  observation: NormalizedObservationRow,
  providerCardMap: ProviderCardMapRow,
  nowIso: string,
): MatchWriteRow | null {
  if (providerCardMap.mapping_status !== "MATCHED") return null;
  if (providerCardMap.asset_type !== observation.asset_type) return null;
  if (!providerCardMap.canonical_slug || !providerCardMap.printing_id) return null;

  return {
    provider_normalized_observation_id: observation.id,
    provider: PROVIDER,
    asset_type: observation.asset_type,
    provider_set_id: observation.provider_set_id,
    provider_card_id: observation.provider_card_id,
    provider_variant_id: observation.provider_variant_id,
    canonical_slug: providerCardMap.canonical_slug,
    printing_id: providerCardMap.printing_id,
    match_status: "MATCHED",
    match_type: providerCardMap.match_type ?? "PROVIDER_CARD_MAP",
    match_confidence: providerCardMap.match_confidence ?? 1,
    match_reason: null,
    metadata: {
      ...(providerCardMap.metadata ?? {}),
      providerKey: providerCardMap.provider_key,
      resolvedFrom: "provider_card_map",
    },
    updated_at: nowIso,
  };
}

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function hasDeadlinePassed(deadlineMs: number | null): boolean {
  return typeof deadlineMs === "number" && Number.isFinite(deadlineMs) && Date.now() >= deadlineMs;
}

async function finalizeStaleStartedMatchRuns(maxRuntimeMs: number): Promise<number> {
  const supabase = dbAdmin();
  const staleAfterMs = Math.max(60000, maxRuntimeMs * Math.max(1, STARTED_RUN_STALE_MULTIPLIER));
  const cutoffIso = new Date(Date.now() - staleAfterMs).toISOString();
  const finalizedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from("ingest_runs")
    .update({
      status: "finished",
      ok: false,
      ended_at: finalizedAt,
      items_failed: 1,
      meta: {
        autoFinalized: true,
        firstError: "AUTO_FINALIZED_STALE_STARTED_RUN",
        finalizedAt,
      },
    })
    .eq("job", JOB)
    .eq("source", "scrydex")
    .eq("status", "started")
    .lt("started_at", cutoffIso)
    .select("id");

  if (error) {
    throw new Error(`ingest_runs(finalize stale started): ${error.message}`);
  }
  return (data ?? []).length;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeLanguageToCanonical(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") return "EN";
  if (normalized === "en") return "EN";
  if (normalized === "jp" || normalized === "ja") return "JP";
  if (normalized === "kr") return "KR";
  if (normalized === "fr") return "FR";
  if (normalized === "de") return "DE";
  if (normalized === "es") return "ES";
  if (normalized === "it") return "IT";
  if (normalized === "pt") return "PT";
  return normalized.toUpperCase();
}

function buildUnmatchedRow(
  observation: NormalizedObservationRow,
  nowIso: string,
  reason: string,
  metadata: Record<string, unknown> = {},
): MatchWriteRow {
  return {
    provider_normalized_observation_id: observation.id,
    provider: PROVIDER,
    asset_type: observation.asset_type,
    provider_set_id: observation.provider_set_id,
    provider_card_id: observation.provider_card_id,
    provider_variant_id: observation.provider_variant_id,
    canonical_slug: null,
    printing_id: null,
    match_status: "UNMATCHED",
    match_type: null,
    match_confidence: null,
    match_reason: reason,
    metadata,
    updated_at: nowIso,
  };
}

function buildMatchedRow(
  observation: NormalizedObservationRow,
  printing: PrintingRow,
  nowIso: string,
  matchType: string,
  matchConfidence: number,
  metadata: Record<string, unknown> = {},
): MatchWriteRow {
  return {
    provider_normalized_observation_id: observation.id,
    provider: PROVIDER,
    asset_type: observation.asset_type,
    provider_set_id: observation.provider_set_id,
    provider_card_id: observation.provider_card_id,
    provider_variant_id: observation.provider_variant_id,
    canonical_slug: printing.canonical_slug,
    printing_id: printing.id,
    match_status: "MATCHED",
    match_type: matchType,
    match_confidence: matchConfidence,
    match_reason: null,
    metadata,
    updated_at: nowIso,
  };
}

function dedupeMatchWriteRows(rows: MatchWriteRow[]): MatchWriteRow[] {
  const deduped = new Map<string, MatchWriteRow>();
  for (const row of rows) {
    deduped.set(row.provider_normalized_observation_id, row);
  }
  return Array.from(deduped.values());
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

async function upsertMatchWriteRows(
  rows: MatchWriteRow[],
): Promise<void> {
  const supabase = dbAdmin();
  const dedupedRows = dedupeMatchWriteRows(rows);

  for (const batch of chunkRows(dedupedRows, MATCH_UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from("provider_observation_matches")
      .upsert(batch, {
        onConflict: "provider_normalized_observation_id",
      });

    if (!error) continue;

    const message = error.message ?? "unknown error";
    const isDuplicateConflict = message.includes("cannot affect row a second time");
    if (!isDuplicateConflict || batch.length === 1) {
      throw new Error(`provider_observation_matches: ${message}`);
    }

    for (const row of batch) {
      const { error: rowError } = await supabase
        .from("provider_observation_matches")
        .upsert(row, {
          onConflict: "provider_normalized_observation_id",
        });

      if (rowError) {
        throw new Error(`provider_observation_matches: ${rowError.message}`);
      }
    }
  }
}

async function loadCandidateObservations(params: {
  observationLimit: number;
  providerSetId?: string | null;
  observationId?: string | null;
  force?: boolean;
  scanDirection?: ScanDirection;
  mode?: MatchMode;
  recentWindowHours?: number;
  incrementalMaxScanRows?: number;
  prioritizedProviderSetIds?: string[];
  deadlineMs?: number | null;
}): Promise<{
  rows: NormalizedObservationRow[];
  scanned: number;
  skippedAlreadyMatched: number;
  timedOut: boolean;
}> {
  const supabase = dbAdmin();
  const force = params.force === true || Boolean(params.observationId);
  const ascending = params.scanDirection === "oldest";
  let timedOut = false;

  if (params.observationId) {
    let query = supabase
      .from("provider_normalized_observations")
      .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language, observed_at")
      .eq("id", params.observationId)
      .eq("provider", PROVIDER);

    if (params.providerSetId) {
      query = query.eq("provider_set_id", params.providerSetId);
    }

    const { data, error } = await query.maybeSingle<NormalizedObservationRow>();
    if (error) throw new Error(`provider_normalized_observations(load by id): ${error.message}`);
    return { rows: data ? [data] : [], scanned: data ? 1 : 0, skippedAlreadyMatched: 0, timedOut: false };
  }

  const selected: NormalizedObservationRow[] = [];
  const selectedObservationIds = new Set<string>();
  let scanned = 0;
  let skippedAlreadyMatched = 0;
  const unmatchedRetryMs = Math.max(1, UNMATCHED_RETRY_HOURS) * 60 * 60 * 1000;
  const nowMs = Date.now();
  const mode: MatchMode = params.mode ?? DEFAULT_MATCH_MODE;
  const recentWindowHours = Math.max(1, params.recentWindowHours ?? INCREMENTAL_RECENT_WINDOW_HOURS);
  const incrementalMaxScanRows = Math.max(100, params.incrementalMaxScanRows ?? INCREMENTAL_MAX_SCAN_ROWS);
  const recentCutoffIso = new Date(nowMs - (recentWindowHours * 60 * 60 * 1000)).toISOString();

  async function loadExistingMap(ids: string[]): Promise<Map<string, ExistingMatchRow>> {
    if (ids.length === 0 || force) return new Map();
    const { data: existingRows, error: existingError } = await supabase
      .from("provider_observation_matches")
      .select("provider_normalized_observation_id, match_status, updated_at")
      .in("provider_normalized_observation_id", ids);

    if (existingError) {
      throw new Error(`provider_observation_matches(scan existing): ${existingError.message}`);
    }

    const out = new Map<string, ExistingMatchRow>();
    for (const row of (existingRows ?? []) as ExistingMatchRow[]) {
      out.set(String(row.provider_normalized_observation_id), row);
    }
    return out;
  }

  async function addSelectedIdsFromScan(scanRows: ScanRow[]): Promise<void> {
    const existingById = await loadExistingMap(scanRows.map((row) => row.id));
    const selectedIds: string[] = [];
    for (const row of scanRows) {
      if (hasDeadlinePassed(params.deadlineMs ?? null)) {
        timedOut = true;
        break;
      }
      if (selectedObservationIds.has(row.id)) {
        continue;
      }
      if (!force) {
        const existing = existingById.get(row.id);
        if (existing?.match_status === "MATCHED") {
          skippedAlreadyMatched += 1;
          continue;
        }
        if (existing?.match_status === "UNMATCHED") {
          const updatedAtMs = parseDateMs(existing.updated_at);
          if (updatedAtMs !== null && (nowMs - updatedAtMs) < unmatchedRetryMs) {
            skippedAlreadyMatched += 1;
            continue;
          }
        }
      }
      selectedIds.push(row.id);
      selectedObservationIds.add(row.id);
      if (selected.length + selectedIds.length >= params.observationLimit) break;
    }

    if (selectedIds.length === 0 || timedOut) return;
    const { data: fullRows, error: fullError } = await supabase
      .from("provider_normalized_observations")
      .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language, observed_at")
      .in("id", selectedIds);

    if (fullError) throw new Error(`provider_normalized_observations(load selected): ${fullError.message}`);
    const byId = new Map<string, NormalizedObservationRow>();
    for (const row of (fullRows ?? []) as NormalizedObservationRow[]) byId.set(row.id, row);
    for (const id of selectedIds) {
      const row = byId.get(id);
      if (!row) continue;
      selected.push(row);
      if (selected.length >= params.observationLimit) break;
    }
  }

  async function scanLoop(providerSetId: string | null, recentOnly: boolean, maxScanRows: number): Promise<void> {
    let cursorAt: string | null = null;
    let totalScanned = 0;

    while (selected.length < params.observationLimit && totalScanned < maxScanRows) {
      if (hasDeadlinePassed(params.deadlineMs ?? null)) {
        timedOut = true;
        break;
      }
      let scanQuery = supabase
        .from("provider_normalized_observations")
        .select("id, observed_at")
        .eq("provider", PROVIDER)
        .order("observed_at", { ascending })
        .order("id", { ascending })
        .limit(SCAN_PAGE_SIZE);

      if (providerSetId) scanQuery = scanQuery.eq("provider_set_id", providerSetId);
      if (params.providerSetId) scanQuery = scanQuery.eq("provider_set_id", params.providerSetId);
      if (recentOnly) scanQuery = scanQuery.gte("observed_at", recentCutoffIso);

      if (cursorAt !== null) {
        scanQuery = ascending
          ? scanQuery.gte("observed_at", cursorAt)
          : scanQuery.lte("observed_at", cursorAt);
      }

      const { data, error } = await scanQuery;
      if (error) throw new Error(`provider_normalized_observations(scan): ${error.message}`);
      const scanRows = (data ?? []) as ScanRow[];
      if (scanRows.length === 0) break;
      totalScanned += scanRows.length;
      scanned += scanRows.length;

      const lastRow = scanRows[scanRows.length - 1];
      const prevCursor: string | null = cursorAt;
      cursorAt = lastRow.observed_at;

      await addSelectedIdsFromScan(scanRows);
      if (timedOut || selected.length >= params.observationLimit) break;

      // If cursor didn't advance, we've exhausted rows at this timestamp
      if (prevCursor === cursorAt) break;
    }
  }

  if (mode === "incremental" && !params.observationId) {
    const prioritizedSetIds = (params.prioritizedProviderSetIds ?? []).slice(0, INCREMENTAL_HOT_SET_LIMIT);
    if (params.providerSetId) {
      await scanLoop(params.providerSetId, true, incrementalMaxScanRows);
    } else {
      for (const setId of prioritizedSetIds) {
        await scanLoop(setId, true, Math.floor(incrementalMaxScanRows / Math.max(1, prioritizedSetIds.length)));
        if (timedOut || selected.length >= params.observationLimit) break;
      }
      if (!timedOut && selected.length < params.observationLimit) {
        await scanLoop(null, true, incrementalMaxScanRows);
      }
    }
    return { rows: selected, scanned, skippedAlreadyMatched, timedOut };
  }

  {
    let cursorAt: string | null = null;

    while (selected.length < params.observationLimit) {
      if (hasDeadlinePassed(params.deadlineMs ?? null)) {
        timedOut = true;
        break;
      }

      let scanQuery = supabase
        .from("provider_normalized_observations")
        .select("id, observed_at")
        .eq("provider", PROVIDER)
        .order("observed_at", { ascending })
        .order("id", { ascending })
        .limit(SCAN_PAGE_SIZE);

      if (params.providerSetId) {
        scanQuery = scanQuery.eq("provider_set_id", params.providerSetId);
      }

      if (cursorAt !== null) {
        scanQuery = ascending
          ? scanQuery.gte("observed_at", cursorAt)
          : scanQuery.lte("observed_at", cursorAt);
      }

      const { data, error } = await scanQuery;
      if (error) throw new Error(`provider_normalized_observations(scan): ${error.message}`);

      const scanRows = (data ?? []) as ScanRow[];
      if (scanRows.length === 0) break;
      scanned += scanRows.length;

      const lastRow = scanRows[scanRows.length - 1];
      const prevCursor: string | null = cursorAt;
      cursorAt = lastRow.observed_at;

      const existingById = new Map<string, ExistingMatchRow>();
      if (!force) {
        const { data: existingRows, error: existingError } = await supabase
          .from("provider_observation_matches")
          .select("provider_normalized_observation_id, match_status, updated_at")
          .in("provider_normalized_observation_id", scanRows.map((row) => row.id));

        if (existingError) {
          throw new Error(`provider_observation_matches(scan existing): ${existingError.message}`);
        }

        for (const row of (existingRows ?? []) as ExistingMatchRow[]) {
          existingById.set(String(row.provider_normalized_observation_id), row);
        }
      }

      const selectedIds: string[] = [];
      for (const row of scanRows) {
        if (hasDeadlinePassed(params.deadlineMs ?? null)) {
          timedOut = true;
          break;
        }
        if (selectedObservationIds.has(row.id)) {
          continue;
        }
        if (!force) {
          const existing = existingById.get(row.id);
          if (existing?.match_status === "MATCHED") {
            skippedAlreadyMatched += 1;
            continue;
          }
          if (existing?.match_status === "UNMATCHED") {
            const updatedAtMs = parseDateMs(existing.updated_at);
            if (updatedAtMs !== null && (nowMs - updatedAtMs) < unmatchedRetryMs) {
              skippedAlreadyMatched += 1;
              continue;
            }
          }
        }
        selectedIds.push(row.id);
        selectedObservationIds.add(row.id);
        if (selected.length + selectedIds.length >= params.observationLimit) break;
      }

      if (selectedIds.length === 0) continue;

      const { data: fullRows, error: fullError } = await supabase
        .from("provider_normalized_observations")
        .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language, observed_at")
        .in("id", selectedIds);

      if (fullError) {
        throw new Error(`provider_normalized_observations(load selected): ${fullError.message}`);
      }

      const byId = new Map<string, NormalizedObservationRow>();
      for (const row of (fullRows ?? []) as NormalizedObservationRow[]) {
        byId.set(row.id, row);
      }

      for (const id of selectedIds) {
        if (hasDeadlinePassed(params.deadlineMs ?? null)) {
          timedOut = true;
          break;
        }
        const row = byId.get(id);
        if (!row) continue;
        selected.push(row);
        if (selected.length >= params.observationLimit) break;
      }
      if (timedOut) break;

      // If cursor didn't advance, we've exhausted rows at this timestamp
      if (prevCursor === cursorAt) break;
    }
  }

  return { rows: selected, scanned, skippedAlreadyMatched, timedOut };
}

async function loadIncrementalHotProviderSetIds(maxProviderSetIds: number): Promise<string[]> {
  const mapped = await loadProviderSetIndex("SCRYDEX");
  if (mapped.length === 0) return [];
  const targets = mapped.map((row) => ({
    setCode: row.canonicalSetCode,
    setName: row.canonicalSetName ?? row.canonicalSetCode,
    providerSetId: row.providerSetId,
  }));
  const [recentConsistencySetIds, highValueSetIds] = await Promise.all([
    loadRecentSetConsistencyPriority({
      provider: "SCRYDEX",
      targets,
      yearFrom: 2024,
      freshWindowHours: 24,
      maxProviderSetIds: Math.max(1, maxProviderSetIds),
    }),
    loadHighValueStaleSetPriority({
      provider: "SCRYDEX",
      targets,
      staleWindowHours: 24,
      maxProviderSetIds: Math.max(1, maxProviderSetIds),
    }),
  ]);
  return [...new Set([...recentConsistencySetIds, ...highValueSetIds])].slice(
    0,
    Math.max(1, maxProviderSetIds),
  );
}

async function loadProviderSetMap(providerSetIds: string[]): Promise<Map<string, string>> {
  if (providerSetIds.length === 0) return new Map();

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_set_map")
    .select("provider_set_id, canonical_set_code")
    .eq("provider", PROVIDER)
    .in("provider_set_id", providerSetIds);

  if (error) {
    throw new Error(`provider_set_map: ${error.message}`);
  }

  const bySetId = new Map<string, string>();
  for (const row of (data ?? []) as ProviderSetMapRow[]) {
    bySetId.set(row.provider_set_id, row.canonical_set_code);
  }
  // Scrydex uses expansion ids that align with canonical set_code.
  // If an explicit provider_set_map row is missing, fallback to identity.
  for (const providerSetId of providerSetIds) {
    if (!bySetId.has(providerSetId)) {
      bySetId.set(providerSetId, providerSetId);
    }
  }
  return bySetId;
}

async function loadCardPrintings(setCodes: string[]): Promise<Map<string, PrintingRow[]>> {
  if (setCodes.length === 0) return new Map();

  const supabase = dbAdmin();
  const pageSize = 1000;
  const rows: PrintingRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("id, canonical_slug, set_code, card_number, language, finish, edition, stamp")
      .in("set_code", setCodes)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`card_printings: ${error.message}`);
    }

    const batch = (data ?? []) as PrintingRow[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  const bySetCode = new Map<string, PrintingRow[]>();
  for (const row of rows) {
    const setCode = String(row.set_code ?? "");
    if (!setCode) continue;
    const bucket = bySetCode.get(setCode) ?? [];
    bucket.push(row);
    bySetCode.set(setCode, bucket);
  }
  return bySetCode;
}

export function chooseSinglePrinting(params: {
  observation: NormalizedObservationRow;
  canonicalSetCode: string;
  printingRows: PrintingRow[];
}): MatchDecision {
  const { observation, canonicalSetCode, printingRows } = params;
  const language = normalizeLanguageToCanonical(observation.normalized_language);
  const cardNumber = String(observation.normalized_card_number ?? "").trim();
  if (!cardNumber) {
    return { matched: false, reason: "MISSING_NORMALIZED_CARD_NUMBER", metadata: {} };
  }

  const setRows = printingRows.filter((row) =>
    row.set_code === canonicalSetCode
    && row.card_number === cardNumber
    && row.language === language
  );

  if (setRows.length === 0) {
    return {
      matched: false,
      reason: "NO_PRINTINGS_FOR_SET_NUMBER_LANGUAGE",
      metadata: { canonicalSetCode, cardNumber, language },
    };
  }

  const targetStamp = normalizeScrydexStampToken(observation.normalized_stamp);
  const strictRows = setRows.filter((row) =>
    row.finish === observation.normalized_finish
    && row.edition === observation.normalized_edition
    && normalizeScrydexStampToken(row.stamp) === targetStamp
  );

  if (strictRows.length === 1) {
    return {
      matched: true,
      printing: strictRows[0],
      matchType: "PRINTING_EXACT",
      confidence: 1,
      metadata: { canonicalSetCode, cardNumber, language },
    };
  }

  const providerVariantToken = normalizeScrydexVariantToken(
    String(observation.provider_variant_id ?? "").split(":").at(-1) ?? "",
  );
  const hasSpecialVariantToken = (
    targetStamp !== "NONE"
    || hasScrydexSpecialVariantToken(providerVariantToken)
  );
  if (hasSpecialVariantToken) {
    return {
      matched: false,
      reason: "SPECIAL_VARIANT_EXACT_MATCH_REQUIRED",
      metadata: {
        canonicalSetCode,
        cardNumber,
        language,
        providerVariantToken,
        targetStamp,
        candidates: setRows.length,
        strictCandidates: strictRows.length,
      },
    };
  }

  const isBasicProviderVariant = new Set([
    "unknown",
    "normal",
    "nonholo",
    "nonholofoil",
    "holo",
    "holofoil",
    "foil",
    "reverse",
    "reversefoil",
    "reverseholo",
    "reverseholofoil",
  ]).has(providerVariantToken);

  if (setRows.length === 1) {
    const onlyPrinting = setRows[0];
    if (onlyPrinting.finish === "UNKNOWN" && isBasicProviderVariant) {
      return {
        matched: true,
        printing: onlyPrinting,
        matchType: "PRINTING_NUMBER_ONLY_CANONICAL_UNKNOWN",
        confidence: 0.93,
        metadata: {
          canonicalSetCode,
          cardNumber,
          language,
          providerVariantToken,
          canonicalFinish: onlyPrinting.finish,
        },
      };
    }

    return {
      matched: true,
      printing: onlyPrinting,
      matchType: "PRINTING_NUMBER_ONLY",
      confidence: 0.88,
      metadata: { canonicalSetCode, cardNumber, language },
    };
  }

  const preferredRows = setRows.filter((row) =>
    row.finish === "NON_HOLO"
    && row.edition === "UNLIMITED"
    && normalizeScrydexStampToken(row.stamp) === "NONE"
  );
  if (preferredRows.length === 1) {
    return {
      matched: true,
      printing: preferredRows[0],
      matchType: "PRINTING_NUMBER_PREF_NON_HOLO",
      confidence: 0.82,
      metadata: { canonicalSetCode, cardNumber, language, candidates: setRows.length },
    };
  }

  return {
    matched: false,
    reason: "AMBIGUOUS_NUMBER_ONLY_MATCH",
    metadata: { canonicalSetCode, cardNumber, language, candidates: setRows.length },
  };
}

export async function runPokemonTcgNormalizedMatch(opts: {
  observationLimit?: number;
  providerSetId?: string | null;
  observationId?: string | null;
  force?: boolean;
  scanDirection?: ScanDirection;
  maxRuntimeMs?: number;
  mode?: MatchMode;
  recentWindowHours?: number;
} = {}): Promise<MatchResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const observationLimit = parsePositiveInt(opts.observationLimit, DEFAULT_OBSERVATIONS_PER_RUN);
  const maxRuntimeMs = parsePositiveInt(opts.maxRuntimeMs, DEFAULT_MATCH_MAX_RUNTIME_MS);
  const mode: MatchMode = opts.mode ?? DEFAULT_MATCH_MODE;
  const recentWindowHours = Math.max(1, Math.floor(opts.recentWindowHours ?? INCREMENTAL_RECENT_WINDOW_HOURS));
  const deadlineMs = Date.now() + maxRuntimeMs;
  const staleStartedRunsFinalized = await finalizeStaleStartedMatchRuns(maxRuntimeMs);
  const prioritizedProviderSetIds = mode === "incremental" && !opts.providerSetId
    ? await loadIncrementalHotProviderSetIds(INCREMENTAL_HOT_SET_LIMIT)
    : [];

  let firstError: string | null = null;
  let observationsScanned = 0;
  let observationsSkippedAlreadyMatched = 0;
  let observationsProcessed = 0;
  let matchedCount = 0;
  let unmatchedCount = 0;
  let singlesMatched = 0;
  const sealedMatched = 0;
  const sampleMatches: MatchSample[] = [];

  const { data: runRow, error: runStartError } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "scrydex",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: {
        mode: "match-only",
        matchMode: mode,
        observationLimit,
        providerSetId: opts.providerSetId ?? null,
        observationId: opts.observationId ?? null,
        force: opts.force === true,
        scanDirection: opts.scanDirection ?? "newest",
        recentWindowHours,
        minAutoMatchConfidence: MIN_AUTO_MATCH_CONFIDENCE,
        maxRuntimeMs,
        staleStartedRunsFinalized,
      },
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (runStartError) {
    throw new Error(`ingest_runs(start): ${runStartError.message}`);
  }

  const runId = runRow?.id ?? null;

  try {
    const candidateResult = await loadCandidateObservations({
      observationLimit,
      providerSetId: opts.providerSetId,
      observationId: opts.observationId,
      force: opts.force,
      mode,
      scanDirection: opts.scanDirection,
      recentWindowHours,
      prioritizedProviderSetIds,
      deadlineMs,
    });

    if (candidateResult.timedOut) {
      throw new Error(
        `MATCH_RUNTIME_TIMEOUT_CANDIDATE_SCAN after ${Math.floor(maxRuntimeMs / 1000)}s`
      );
    }

    observationsScanned = candidateResult.scanned;
    observationsSkippedAlreadyMatched = candidateResult.skippedAlreadyMatched;

    if (hasDeadlinePassed(deadlineMs)) {
      throw new Error(`MATCH_RUNTIME_TIMEOUT_PRE_MATCH after ${Math.floor(maxRuntimeMs / 1000)}s`);
    }

    const providerSetIds = Array.from(new Set(
      candidateResult.rows
        .map((row) => row.provider_set_id)
        .filter((value): value is string => Boolean(value)),
    ));
    const providerCardMapByKey = await loadProviderCardMapByKeys({
      provider: PROVIDER,
      providerKeys: candidateResult.rows.map((row) =>
        buildProviderCardMapKey(row.provider_card_id, row.provider_variant_id)),
    });
    const providerSetMap = await loadProviderSetMap(providerSetIds);
    const setCodes = Array.from(new Set(providerSetMap.values()));
    const printingsBySetCode = await loadCardPrintings(setCodes);

    const writes: MatchWriteRow[] = [];
    const providerCardMapWrites: ProviderCardMapUpsertRow[] = [];
    for (const observation of candidateResult.rows) {
      if (hasDeadlinePassed(deadlineMs)) {
        throw new Error(
          `MATCH_RUNTIME_TIMEOUT_PROCESSING after ${Math.floor(maxRuntimeMs / 1000)}s`
        );
      }
      observationsProcessed += 1;
      const nowIso = new Date().toISOString();
      const providerKey = buildProviderCardMapKey(observation.provider_card_id, observation.provider_variant_id);
      const existingProviderCardMap = opts.force
        ? null
        : (providerCardMapByKey.get(providerKey) ?? null);

      const reusedRow = existingProviderCardMap
        ? buildMatchedRowFromProviderCardMap(observation, existingProviderCardMap, nowIso)
        : null;
      if (reusedRow) {
        writes.push(reusedRow);
        providerCardMapWrites.push(buildProviderCardMapUpsertRow({
          provider: PROVIDER,
          assetType: observation.asset_type,
          providerSetId: observation.provider_set_id,
          providerCardId: observation.provider_card_id,
          providerVariantId: observation.provider_variant_id,
          canonicalSlug: reusedRow.canonical_slug,
          printingId: reusedRow.printing_id,
          mappingStatus: "MATCHED",
          matchType: reusedRow.match_type,
          matchConfidence: reusedRow.match_confidence,
          matchReason: null,
          mappingSource: "PIPELINE",
          metadata: reusedRow.metadata,
          observedAt: observation.observed_at,
          matchedAt: nowIso,
          updatedAt: nowIso,
        }));
        matchedCount += 1;
        singlesMatched += 1;
        if (sampleMatches.length < 25) {
          sampleMatches.push({
            observationId: observation.id,
            providerSetId: observation.provider_set_id,
            providerCardId: observation.provider_card_id,
            providerVariantId: observation.provider_variant_id,
            assetType: observation.asset_type,
            matchStatus: reusedRow.match_status,
            printingId: reusedRow.printing_id,
            canonicalSlug: reusedRow.canonical_slug,
            matchType: reusedRow.match_type,
            matchReason: null,
          });
        }
        continue;
      }

      const providerSetId = String(observation.provider_set_id ?? "").trim();
      if (!providerSetId) {
        const row = buildUnmatchedRow(observation, nowIso, "MISSING_PROVIDER_SET_ID");
        writes.push(row);
        providerCardMapWrites.push(buildProviderCardMapUpsertRow({
          provider: PROVIDER,
          assetType: observation.asset_type,
          providerSetId: observation.provider_set_id,
          providerCardId: observation.provider_card_id,
          providerVariantId: observation.provider_variant_id,
          mappingStatus: "UNMATCHED",
          matchReason: row.match_reason,
          mappingSource: "PIPELINE",
          metadata: row.metadata,
          observedAt: observation.observed_at,
          updatedAt: nowIso,
        }));
        unmatchedCount += 1;
        continue;
      }

      const canonicalSetCode = providerSetMap.get(providerSetId);
      if (!canonicalSetCode) {
        const row = buildUnmatchedRow(observation, nowIso, "MISSING_PROVIDER_SET_MAP", { providerSetId });
        writes.push(row);
        providerCardMapWrites.push(buildProviderCardMapUpsertRow({
          provider: PROVIDER,
          assetType: observation.asset_type,
          providerSetId: observation.provider_set_id,
          providerCardId: observation.provider_card_id,
          providerVariantId: observation.provider_variant_id,
          mappingStatus: "UNMATCHED",
          matchReason: row.match_reason,
          mappingSource: "PIPELINE",
          metadata: row.metadata,
          observedAt: observation.observed_at,
          updatedAt: nowIso,
        }));
        unmatchedCount += 1;
        continue;
      }

      const setPrintings = printingsBySetCode.get(canonicalSetCode) ?? [];
      const decision = chooseSinglePrinting({
        observation,
        canonicalSetCode,
        printingRows: setPrintings,
      });

      if (!decision.matched) {
        const row = buildUnmatchedRow(observation, nowIso, decision.reason, decision.metadata);
        writes.push(row);
        providerCardMapWrites.push(buildProviderCardMapUpsertRow({
          provider: PROVIDER,
          assetType: observation.asset_type,
          providerSetId: observation.provider_set_id,
          providerCardId: observation.provider_card_id,
          providerVariantId: observation.provider_variant_id,
          mappingStatus: "UNMATCHED",
          matchReason: row.match_reason,
          mappingSource: "PIPELINE",
          metadata: row.metadata,
          observedAt: observation.observed_at,
          updatedAt: nowIso,
        }));
        unmatchedCount += 1;
        if (sampleMatches.length < 25) {
          sampleMatches.push({
            observationId: observation.id,
            providerSetId: observation.provider_set_id,
            providerCardId: observation.provider_card_id,
            providerVariantId: observation.provider_variant_id,
            assetType: observation.asset_type,
            matchStatus: row.match_status,
            printingId: null,
            canonicalSlug: null,
            matchType: null,
            matchReason: row.match_reason,
          });
        }
        continue;
      }

      if (decision.confidence < MIN_AUTO_MATCH_CONFIDENCE) {
        const row = buildUnmatchedRow(observation, nowIso, "LOW_CONFIDENCE_MATCH_BLOCKED", {
          ...decision.metadata,
          proposedMatchType: decision.matchType,
          proposedConfidence: decision.confidence,
          minAutoMatchConfidence: MIN_AUTO_MATCH_CONFIDENCE,
        });
        writes.push(row);
        providerCardMapWrites.push(buildProviderCardMapUpsertRow({
          provider: PROVIDER,
          assetType: observation.asset_type,
          providerSetId: observation.provider_set_id,
          providerCardId: observation.provider_card_id,
          providerVariantId: observation.provider_variant_id,
          mappingStatus: "UNMATCHED",
          matchReason: row.match_reason,
          mappingSource: "PIPELINE",
          metadata: row.metadata,
          observedAt: observation.observed_at,
          updatedAt: nowIso,
        }));
        unmatchedCount += 1;
        if (sampleMatches.length < 25) {
          sampleMatches.push({
            observationId: observation.id,
            providerSetId: observation.provider_set_id,
            providerCardId: observation.provider_card_id,
            providerVariantId: observation.provider_variant_id,
            assetType: observation.asset_type,
            matchStatus: row.match_status,
            printingId: null,
            canonicalSlug: null,
            matchType: null,
            matchReason: row.match_reason,
          });
        }
        continue;
      }

      const row = buildMatchedRow(
        observation,
        decision.printing,
        nowIso,
        decision.matchType,
        decision.confidence,
        decision.metadata,
      );
      writes.push(row);
      providerCardMapWrites.push(buildProviderCardMapUpsertRow({
        provider: PROVIDER,
        assetType: observation.asset_type,
        providerSetId: observation.provider_set_id,
        providerCardId: observation.provider_card_id,
        providerVariantId: observation.provider_variant_id,
        canonicalSlug: row.canonical_slug,
        printingId: row.printing_id,
        mappingStatus: "MATCHED",
        matchType: row.match_type,
        matchConfidence: row.match_confidence,
        matchReason: null,
        mappingSource: "PIPELINE",
        metadata: row.metadata,
        observedAt: observation.observed_at,
        matchedAt: nowIso,
        updatedAt: nowIso,
      }));
      matchedCount += 1;
      singlesMatched += 1;
      if (sampleMatches.length < 25) {
        sampleMatches.push({
          observationId: observation.id,
          providerSetId: observation.provider_set_id,
          providerCardId: observation.provider_card_id,
          providerVariantId: observation.provider_variant_id,
          assetType: observation.asset_type,
          matchStatus: row.match_status,
          printingId: row.printing_id,
          canonicalSlug: row.canonical_slug,
          matchType: row.match_type,
          matchReason: null,
        });
      }
    }

    if (writes.length > 0) {
      const dedupedProviderCardMapWrites = dedupeProviderCardMapUpsertRows(providerCardMapWrites);
      const { error: providerCardMapError } = await supabase
        .from("provider_card_map")
        .upsert(dedupedProviderCardMapWrites, {
          onConflict: "provider,provider_key",
        });

      if (providerCardMapError) {
        throw new Error(`provider_card_map: ${providerCardMapError.message}`);
      }

      await upsertMatchWriteRows(writes);
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  const endedAt = new Date().toISOString();
  const result: MatchResult = {
    ok: firstError === null,
    job: JOB,
    provider: PROVIDER,
    startedAt,
    endedAt,
    observationsRequested: observationLimit,
    observationsScanned,
    observationsProcessed,
    observationsSkippedAlreadyMatched,
    matchedCount,
    unmatchedCount,
    singlesMatched,
    sealedMatched,
    firstError,
    sampleMatches,
  };

  if (runId) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: result.ok,
        items_fetched: observationsProcessed,
        items_upserted: matchedCount,
        items_failed: unmatchedCount + (firstError ? 1 : 0),
        ended_at: endedAt,
        meta: {
          mode: "match-only",
          matchMode: mode,
          observationLimit,
          providerSetId: opts.providerSetId ?? null,
          observationId: opts.observationId ?? null,
          force: opts.force === true,
          scanDirection: opts.scanDirection ?? "newest",
          recentWindowHours,
          minAutoMatchConfidence: MIN_AUTO_MATCH_CONFIDENCE,
          maxRuntimeMs,
          staleStartedRunsFinalized,
          observationsScanned,
          observationsProcessed,
          observationsSkippedAlreadyMatched,
          matchedCount,
          unmatchedCount,
          singlesMatched,
          sealedMatched,
          sampleMatches,
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}

export async function runScrydexNormalizedMatch(opts: {
  observationLimit?: number;
  providerSetId?: string | null;
  observationId?: string | null;
  force?: boolean;
  scanDirection?: ScanDirection;
  maxRuntimeMs?: number;
  mode?: MatchMode;
  recentWindowHours?: number;
} = {}): Promise<MatchResult> {
  return runPokemonTcgNormalizedMatch(opts);
}
