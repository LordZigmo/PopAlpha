import { dbAdmin } from "@/lib/db/admin";

const PROVIDER = "SCRYDEX";
const JOB = "scrydex_normalized_match";
const DEFAULT_OBSERVATIONS_PER_RUN = process.env.POKEMONTCG_MATCH_OBSERVATIONS_PER_RUN
  ? parseInt(process.env.POKEMONTCG_MATCH_OBSERVATIONS_PER_RUN, 10)
  : 1200;
const UNMATCHED_RETRY_HOURS = process.env.SCRYDEX_UNMATCHED_RETRY_HOURS
  ? parseInt(process.env.SCRYDEX_UNMATCHED_RETRY_HOURS, 10)
  : 6;
const MIN_AUTO_MATCH_CONFIDENCE = process.env.SCRYDEX_MIN_AUTO_MATCH_CONFIDENCE
  ? Number.parseFloat(process.env.SCRYDEX_MIN_AUTO_MATCH_CONFIDENCE)
  : 0.9;
const SCAN_PAGE_SIZE = 100;
type ScanDirection = "newest" | "oldest";

type ScanRow = {
  id: string;
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
  normalized_stamp: "NONE" | "POKEMON_CENTER";
  normalized_language: string;
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

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeStampToken(value: string | null | undefined): "NONE" | string {
  const text = String(value ?? "").trim();
  if (!text) return "NONE";
  const normalized = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "NONE";
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

async function loadCandidateObservations(params: {
  observationLimit: number;
  providerSetId?: string | null;
  observationId?: string | null;
  force?: boolean;
  scanDirection?: ScanDirection;
}): Promise<{
  rows: NormalizedObservationRow[];
  scanned: number;
  skippedAlreadyMatched: number;
}> {
  const supabase = dbAdmin();
  const force = params.force === true || Boolean(params.observationId);
  const ascending = params.scanDirection === "oldest";

  if (params.observationId) {
    let query = supabase
      .from("provider_normalized_observations")
      .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language")
      .eq("id", params.observationId)
      .eq("provider", PROVIDER);

    if (params.providerSetId) {
      query = query.eq("provider_set_id", params.providerSetId);
    }

    const { data, error } = await query.maybeSingle<NormalizedObservationRow>();
    if (error) throw new Error(`provider_normalized_observations(load by id): ${error.message}`);
    return { rows: data ? [data] : [], scanned: data ? 1 : 0, skippedAlreadyMatched: 0 };
  }

  const selected: NormalizedObservationRow[] = [];
  let scanned = 0;
  let skippedAlreadyMatched = 0;
  const unmatchedRetryMs = Math.max(1, UNMATCHED_RETRY_HOURS) * 60 * 60 * 1000;
  const nowMs = Date.now();

  for (let from = 0; selected.length < params.observationLimit; from += SCAN_PAGE_SIZE) {
    let scanQuery = supabase
      .from("provider_normalized_observations")
      .select("id")
      .eq("provider", PROVIDER)
      .order("observed_at", { ascending })
      .order("id", { ascending })
      .range(from, from + SCAN_PAGE_SIZE - 1);

    if (params.providerSetId) {
      scanQuery = scanQuery.eq("provider_set_id", params.providerSetId);
    }

    const { data, error } = await scanQuery;
    if (error) throw new Error(`provider_normalized_observations(scan): ${error.message}`);

    const scanRows = (data ?? []) as ScanRow[];
    if (scanRows.length === 0) break;
    scanned += scanRows.length;

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
      if (selected.length + selectedIds.length >= params.observationLimit) break;
    }

    if (selectedIds.length === 0) continue;

    const { data: fullRows, error: fullError } = await supabase
      .from("provider_normalized_observations")
      .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language")
      .in("id", selectedIds);

    if (fullError) {
      throw new Error(`provider_normalized_observations(load selected): ${fullError.message}`);
    }

    const byId = new Map<string, NormalizedObservationRow>();
    for (const row of (fullRows ?? []) as NormalizedObservationRow[]) {
      byId.set(row.id, row);
    }

    for (const id of selectedIds) {
      const row = byId.get(id);
      if (!row) continue;
      selected.push(row);
      if (selected.length >= params.observationLimit) break;
    }
  }

  return { rows: selected, scanned, skippedAlreadyMatched };
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

function chooseSinglePrinting(params: {
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

  const targetStamp = observation.normalized_stamp;
  const strictRows = setRows.filter((row) =>
    row.finish === observation.normalized_finish
    && row.edition === observation.normalized_edition
    && normalizeStampToken(row.stamp) === targetStamp
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

  if (setRows.length === 1) {
    return {
      matched: true,
      printing: setRows[0],
      matchType: "PRINTING_NUMBER_ONLY",
      confidence: 0.88,
      metadata: { canonicalSetCode, cardNumber, language },
    };
  }

  const preferredRows = setRows.filter((row) =>
    row.finish === "NON_HOLO"
    && row.edition === "UNLIMITED"
    && normalizeStampToken(row.stamp) === "NONE"
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
} = {}): Promise<MatchResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const observationLimit = parsePositiveInt(opts.observationLimit, DEFAULT_OBSERVATIONS_PER_RUN);

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
        observationLimit,
        providerSetId: opts.providerSetId ?? null,
        observationId: opts.observationId ?? null,
        force: opts.force === true,
        scanDirection: opts.scanDirection ?? "newest",
        minAutoMatchConfidence: MIN_AUTO_MATCH_CONFIDENCE,
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
      scanDirection: opts.scanDirection,
    });

    observationsScanned = candidateResult.scanned;
    observationsSkippedAlreadyMatched = candidateResult.skippedAlreadyMatched;

    const providerSetIds = Array.from(new Set(
      candidateResult.rows
        .map((row) => row.provider_set_id)
        .filter((value): value is string => Boolean(value)),
    ));
    const providerSetMap = await loadProviderSetMap(providerSetIds);
    const setCodes = Array.from(new Set(providerSetMap.values()));
    const printingsBySetCode = await loadCardPrintings(setCodes);

    const writes: MatchWriteRow[] = [];
    for (const observation of candidateResult.rows) {
      observationsProcessed += 1;
      const nowIso = new Date().toISOString();

      const providerSetId = String(observation.provider_set_id ?? "").trim();
      if (!providerSetId) {
        const row = buildUnmatchedRow(observation, nowIso, "MISSING_PROVIDER_SET_ID");
        writes.push(row);
        unmatchedCount += 1;
        continue;
      }

      const canonicalSetCode = providerSetMap.get(providerSetId);
      if (!canonicalSetCode) {
        const row = buildUnmatchedRow(observation, nowIso, "MISSING_PROVIDER_SET_MAP", { providerSetId });
        writes.push(row);
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
      const { error } = await supabase
        .from("provider_observation_matches")
        .upsert(writes, {
          onConflict: "provider_normalized_observation_id",
        });

      if (error) {
        throw new Error(`provider_observation_matches: ${error.message}`);
      }
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
          observationLimit,
          providerSetId: opts.providerSetId ?? null,
          observationId: opts.observationId ?? null,
          force: opts.force === true,
          scanDirection: opts.scanDirection ?? "newest",
          minAutoMatchConfidence: MIN_AUTO_MATCH_CONFIDENCE,
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
