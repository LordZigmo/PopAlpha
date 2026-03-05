import { dbAdmin } from "@/lib/db/admin";

const PROVIDER = "JUSTTCG";
const JOB = "justtcg_normalized_match";
const DEFAULT_OBSERVATIONS_PER_RUN = process.env.JUSTTCG_MATCH_OBSERVATIONS_PER_RUN
  ? parseInt(process.env.JUSTTCG_MATCH_OBSERVATIONS_PER_RUN, 10)
  : 200;
const SCAN_PAGE_SIZE = 100;

type ScanRow = {
  id: string;
  provider_set_id: string | null;
  asset_type: "single" | "sealed";
};

type NormalizedObservationRow = {
  id: string;
  provider: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  asset_type: "single" | "sealed";
  set_name: string | null;
  card_name: string;
  card_number: string | null;
  normalized_card_number: string | null;
  normalized_finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
  normalized_edition: "UNLIMITED" | "FIRST_EDITION";
  normalized_stamp: "NONE" | "POKEMON_CENTER";
  normalized_language: string;
  observed_price: number | null;
  observed_at: string;
  variant_ref: string;
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
  finish_detail: string | null;
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

type MatchedDecision = {
  matched: true;
  matchType: string;
  confidence: number;
  metadata: Record<string, unknown>;
  printing: PrintingRow | null;
  canonicalSlug?: string | null;
};

type UnmatchedDecision = {
  matched: false;
  reason: string;
  metadata: Record<string, unknown>;
};

type MatchDecision = MatchedDecision | UnmatchedDecision;

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

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
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

function unknownFinishTieBreakScore(providerFinish: string): number {
  if (providerFinish === "NON_HOLO") return 6;
  if (providerFinish === "HOLO") return 4;
  if (providerFinish === "REVERSE_HOLO") return 2;
  return 0;
}

function scoreRelaxedPrintingCandidate(params: {
  row: PrintingRow;
  observation: NormalizedObservationRow;
}): number {
  const { row, observation } = params;
  let score = 0;
  const finishMatches = row.finish === observation.normalized_finish;
  const editionMatches = row.edition === observation.normalized_edition;

  // Guardrail: never auto-adopt cross-finish or cross-edition matches.
  if (!finishMatches && observation.normalized_finish !== "UNKNOWN" && row.finish !== "UNKNOWN") {
    return -1000;
  }
  if (!editionMatches && row.edition !== "UNKNOWN") {
    return -1000;
  }

  if (finishMatches) {
    score += 50;
  } else if (row.finish === "UNKNOWN") {
    score += 5;
  } else if (observation.normalized_finish === "UNKNOWN") {
    score += unknownFinishTieBreakScore(row.finish);
  }

  if (editionMatches) {
    score += 35;
  } else {
    score += 5;
  }

  const targetStamp = observation.normalized_stamp;
  const localStamp = normalizeStampToken(row.stamp);
  if (localStamp === targetStamp) {
    score += 25;
  } else if (localStamp === "NONE" || targetStamp === "NONE") {
    // Keep candidate viable when one side has no explicit stamp.
    score += 5;
  }

  return score;
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
}): Promise<{
  rows: NormalizedObservationRow[];
  scanned: number;
  skippedAlreadyMatched: number;
}> {
  const supabase = dbAdmin();
  const force = params.force === true || Boolean(params.observationId);

  if (params.observationId) {
    let query = supabase
      .from("provider_normalized_observations")
      .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, set_name, card_name, card_number, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language, observed_price, observed_at, variant_ref")
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

  for (let from = 0; selected.length < params.observationLimit; from += SCAN_PAGE_SIZE) {
    let scanQuery = supabase
      .from("provider_normalized_observations")
      .select("id, provider_set_id, asset_type")
      .eq("provider", PROVIDER)
      .order("observed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + SCAN_PAGE_SIZE - 1);

    if (params.providerSetId) {
      scanQuery = scanQuery.eq("provider_set_id", params.providerSetId);
    }

    const { data, error } = await scanQuery;
    if (error) throw new Error(`provider_normalized_observations(scan): ${error.message}`);

    const scanRows = (data ?? []) as ScanRow[];
    if (scanRows.length === 0) break;
    scanned += scanRows.length;

    let matchedIds = new Set<string>();
    if (!force) {
      const { data: existingRows, error: existingError } = await supabase
        .from("provider_observation_matches")
        .select("provider_normalized_observation_id")
        .in("provider_normalized_observation_id", scanRows.map((row) => row.id));

      if (existingError) {
        throw new Error(`provider_observation_matches(scan existing): ${existingError.message}`);
      }

      matchedIds = new Set(
        (existingRows ?? []).map((row) => String((row as { provider_normalized_observation_id: string }).provider_normalized_observation_id)),
      );
    }

    const selectedIds: string[] = [];
    for (const row of scanRows) {
      if (!force && matchedIds.has(row.id)) {
        skippedAlreadyMatched += 1;
        continue;
      }
      selectedIds.push(row.id);
      if (selected.length + selectedIds.length >= params.observationLimit) break;
    }

    if (selectedIds.length === 0) continue;

    const { data: fullRows, error: fullError } = await supabase
      .from("provider_normalized_observations")
      .select("id, provider, provider_set_id, provider_card_id, provider_variant_id, asset_type, set_name, card_name, card_number, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language, observed_price, observed_at, variant_ref")
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

function buildSealedCanonicalSlug(providerCardId: string): string {
  return `sealed:${providerCardId}`;
}

async function ensureSealedCanonicalSlugs(observations: NormalizedObservationRow[]): Promise<Set<string>> {
  const sealedRows = observations.filter((row) => row.asset_type === "sealed");
  if (sealedRows.length === 0) return new Set<string>();

  const slugByCardId = new Map<string, { slug: string; cardName: string; setName: string | null }>();
  for (const row of sealedRows) {
    if (slugByCardId.has(row.provider_card_id)) continue;
    slugByCardId.set(row.provider_card_id, {
      slug: buildSealedCanonicalSlug(row.provider_card_id),
      cardName: row.card_name,
      setName: row.set_name,
    });
  }

  const slugs = [...slugByCardId.values()].map((row) => row.slug);
  const supabase = dbAdmin();

  const { data: existingRows, error: existingError } = await supabase
    .from("canonical_cards")
    .select("slug")
    .in("slug", slugs);
  if (existingError) {
    throw new Error(`canonical_cards(load sealed): ${existingError.message}`);
  }

  const existing = new Set((existingRows ?? []).map((row) => String((row as { slug: string }).slug)));
  const missing = [...slugByCardId.values()].filter((row) => !existing.has(row.slug));

  if (missing.length > 0) {
    const { error: upsertError } = await supabase
      .from("canonical_cards")
      .upsert(
        missing.map((row) => ({
          slug: row.slug,
          canonical_name: row.cardName || row.slug,
          subject: row.cardName || null,
          set_name: row.setName,
          year: null,
          card_number: null,
          language: "EN",
          variant: "SEALED",
        })),
        { onConflict: "slug" },
      );

    if (upsertError) {
      throw new Error(`canonical_cards(upsert sealed): ${upsertError.message}`);
    }

    for (const row of missing) {
      existing.add(row.slug);
    }
  }

  return existing;
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
  return bySetId;
}

async function loadCardPrintings(setCodes: string[]): Promise<Map<string, PrintingRow[]>> {
  if (setCodes.length === 0) return new Map();

  const supabase = dbAdmin();
  const pageSize = 2000;
  const rows: PrintingRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("id, canonical_slug, set_code, card_number, language, finish, edition, stamp, finish_detail")
      .in("set_code", setCodes)
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
}): { matched: true; printing: PrintingRow; matchType: string; confidence: number; metadata: Record<string, unknown> }
  | { matched: false; reason: string; metadata: Record<string, unknown> } {
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
      metadata: {
        canonicalSetCode,
        cardNumber,
        language,
      },
    };
  }

  if (strictRows.length > 1) {
    const ranked = [...strictRows].sort((left, right) =>
      String(left.finish_detail ?? "").localeCompare(String(right.finish_detail ?? ""))
      || left.id.localeCompare(right.id)
    );
    const primary = ranked[0];
    const sameShape = ranked.filter((row) =>
      String(row.finish_detail ?? "") === String(primary.finish_detail ?? "")
    );
    if (sameShape.length === 1) {
      return {
        matched: true,
        printing: primary,
        matchType: "PRINTING_EXACT_TIEBREAK_FINISH_DETAIL",
        confidence: 0.98,
        metadata: {
          canonicalSetCode,
          cardNumber,
          language,
          candidateCount: strictRows.length,
          chosenFinishDetail: primary.finish_detail ?? null,
        },
      };
    }

    return {
      matched: false,
      reason: "AMBIGUOUS_STRICT_PRINTING_MATCH",
      metadata: {
        canonicalSetCode,
        cardNumber,
        language,
        candidateCount: strictRows.length,
      },
    };
  }

  const finishEditionRows = setRows.filter((row) =>
    row.finish === observation.normalized_finish
    && row.edition === observation.normalized_edition
  );

  if (finishEditionRows.length === 1
    && targetStamp !== "NONE"
    && normalizeStampToken(finishEditionRows[0].stamp) === "NONE") {
    return {
      matched: true,
      printing: finishEditionRows[0],
      matchType: "PRINTING_STAMP_ADOPTABLE",
      confidence: 0.9,
      metadata: {
        canonicalSetCode,
        cardNumber,
        language,
        targetStamp,
        localStamp: normalizeStampToken(finishEditionRows[0].stamp),
      },
    };
  }

  // Recovery path from Jungle debugging: stamp/detail recovery only.
  // Finish/edition mismatches are disqualified in scoreRelaxedPrintingCandidate().
  const relaxedRanked = [...setRows].sort((left, right) =>
    scoreRelaxedPrintingCandidate({ row: right, observation }) - scoreRelaxedPrintingCandidate({ row: left, observation })
    || String(left.finish_detail ?? "").localeCompare(String(right.finish_detail ?? ""))
    || left.id.localeCompare(right.id),
  );

  if (relaxedRanked.length > 0) {
    const best = relaxedRanked[0];
    const bestScore = scoreRelaxedPrintingCandidate({ row: best, observation });
    if (bestScore < 0) {
      return {
        matched: false,
        reason: "NO_PRINTING_MATCH_STRICT_FINISH_EDITION",
        metadata: {
          canonicalSetCode,
          cardNumber,
          language,
          targetFinish: observation.normalized_finish,
          targetEdition: observation.normalized_edition,
        },
      };
    }
    const tied = relaxedRanked.filter((row) => scoreRelaxedPrintingCandidate({ row, observation }) === bestScore);

    if (tied.length === 1) {
      return {
        matched: true,
        printing: best,
        matchType: "PRINTING_PROVIDER_ADOPTABLE",
        confidence: 0.82,
        metadata: {
          canonicalSetCode,
          cardNumber,
          language,
          targetFinish: observation.normalized_finish,
          localFinish: best.finish,
          targetEdition: observation.normalized_edition,
          localEdition: best.edition,
          targetStamp,
          localStamp: normalizeStampToken(best.stamp),
        },
      };
    }

    const topFinishDetail = String(tied[0]?.finish_detail ?? "");
    const topFinishDetailRows = tied.filter((row) => String(row.finish_detail ?? "") === topFinishDetail);
    if (topFinishDetailRows.length === 1) {
      const chosen = topFinishDetailRows[0];
      return {
        matched: true,
        printing: chosen,
        matchType: "PRINTING_PROVIDER_ADOPTABLE_TIEBREAK_FINISH_DETAIL",
        confidence: 0.8,
        metadata: {
          canonicalSetCode,
          cardNumber,
          language,
          candidateCount: tied.length,
          chosenFinishDetail: chosen.finish_detail ?? null,
          targetFinish: observation.normalized_finish,
          localFinish: chosen.finish,
          targetEdition: observation.normalized_edition,
          localEdition: chosen.edition,
          targetStamp,
          localStamp: normalizeStampToken(chosen.stamp),
        },
      };
    }
  }

  return {
    matched: false,
    reason: "NO_PRINTING_MATCH_AFTER_PROVIDER_ADOPTABLE_FALLBACK",
    metadata: {
      canonicalSetCode,
      cardNumber,
      language,
      candidateCount: setRows.length,
      matchingFinishEditionCount: finishEditionRows.length,
      targetFinish: observation.normalized_finish,
      targetEdition: observation.normalized_edition,
      targetStamp,
    },
  };
}

function chooseSealedMatch(params: {
  observation: NormalizedObservationRow;
  sealedCanonicalSlugs: Set<string>;
}): MatchDecision {
  const { observation, sealedCanonicalSlugs } = params;
  const canonicalSlug = buildSealedCanonicalSlug(observation.provider_card_id);
  if (!sealedCanonicalSlugs.has(canonicalSlug)) {
    return {
      matched: false,
      reason: "SEALED_CANONICAL_MISSING",
      metadata: { variantRef: observation.variant_ref },
    };
  }

  return {
    matched: true,
    matchType: "SEALED_CANONICAL_SLUG",
    confidence: 1,
    metadata: {
      variantRef: observation.variant_ref,
      strategy: "sealed:provider_card_id",
    },
    printing: null,
    canonicalSlug,
  };
}

function chooseObservationMatch(params: {
  observation: NormalizedObservationRow;
  providerSetMap: Map<string, string>;
  printingsBySetCode: Map<string, PrintingRow[]>;
  sealedCanonicalSlugs: Set<string>;
}): MatchDecision {
  const { observation, providerSetMap, printingsBySetCode, sealedCanonicalSlugs } = params;

  if (observation.asset_type === "sealed") {
    return chooseSealedMatch({ observation, sealedCanonicalSlugs });
  }

  const providerSetId = String(observation.provider_set_id ?? "").trim();
  if (!providerSetId) {
    return {
      matched: false,
      reason: "MISSING_PROVIDER_SET_ID",
      metadata: {},
    };
  }

  const canonicalSetCode = providerSetMap.get(providerSetId);
  if (!canonicalSetCode) {
    return {
      matched: false,
      reason: "MISSING_PROVIDER_SET_MAP",
      metadata: { providerSetId },
    };
  }

  const setPrintings = printingsBySetCode.get(canonicalSetCode) ?? [];
  const singleDecision = chooseSinglePrinting({
    observation,
    canonicalSetCode,
    printingRows: setPrintings,
  });
  if (!singleDecision.matched) {
    return singleDecision;
  }

  return {
    matched: true,
    matchType: singleDecision.matchType,
    confidence: singleDecision.confidence,
    metadata: singleDecision.metadata,
    printing: singleDecision.printing,
  };
}

export async function runJustTcgNormalizedMatch(opts: {
  observationLimit?: number;
  providerSetId?: string | null;
  observationId?: string | null;
  force?: boolean;
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
  let sealedMatched = 0;
  const sampleMatches: MatchSample[] = [];

  const { data: runRow, error: runStartError } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "justtcg",
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
    const sealedCanonicalSlugs = await ensureSealedCanonicalSlugs(candidateResult.rows);

    const writes: MatchWriteRow[] = [];
    for (const observation of candidateResult.rows) {
      observationsProcessed += 1;
      const nowIso = new Date().toISOString();

      const decision = chooseObservationMatch({
        observation,
        providerSetMap,
        printingsBySetCode,
        sealedCanonicalSlugs,
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

      const row: MatchWriteRow = decision.printing
        ? buildMatchedRow(
            observation,
            decision.printing,
            nowIso,
            decision.matchType,
            decision.confidence,
            decision.metadata,
          )
        : {
            provider_normalized_observation_id: observation.id,
            provider: PROVIDER,
            asset_type: observation.asset_type,
            provider_set_id: observation.provider_set_id,
            provider_card_id: observation.provider_card_id,
            provider_variant_id: observation.provider_variant_id,
            canonical_slug: decision.canonicalSlug ?? null,
            printing_id: null,
            match_status: "MATCHED",
            match_type: decision.matchType,
            match_confidence: decision.confidence,
            match_reason: null,
            metadata: decision.metadata,
            updated_at: nowIso,
          };
      writes.push(row);
      matchedCount += 1;
      if (observation.asset_type === "single") singlesMatched += 1;
      else sealedMatched += 1;

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
