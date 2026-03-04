import { dbAdmin } from "@/lib/db/admin";
import { buildLegacyVariantRef } from "@/lib/providers/justtcg";
import { normalizeCardNumber, type PtcgApiCard } from "@/lib/providers/pokemon-tcg-api";

const PROVIDER = "POKEMON_TCG_API";
const JOB = "pokemontcg_raw_normalize";
const ENDPOINT = "/episodes/cards";
const DEFAULT_PAYLOADS_PER_RUN = process.env.POKEMONTCG_NORMALIZE_PAYLOADS_PER_RUN
  ? parseInt(process.env.POKEMONTCG_NORMALIZE_PAYLOADS_PER_RUN, 10)
  : 50;
const RAW_SCAN_PAGE_SIZE = 50;

type RawPayloadRow = {
  id: string;
  provider: string;
  endpoint: string;
  params: Record<string, unknown> | null;
  response: {
    data?: PtcgApiCard[];
  } | null;
  status_code: number;
  fetched_at: string;
  request_hash?: string | null;
  response_hash?: string | null;
};

type RawPayloadScanRow = {
  id: string;
  status_code: number;
};

type NormalizedObservationRow = {
  provider_raw_payload_id: string;
  provider: string;
  endpoint: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  asset_type: "single";
  set_name: string | null;
  card_name: string;
  card_number: string | null;
  normalized_card_number: string | null;
  provider_finish: string | null;
  normalized_finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
  normalized_edition: "UNLIMITED" | "FIRST_EDITION";
  normalized_stamp: "NONE" | "POKEMON_CENTER";
  provider_condition: string | null;
  normalized_condition: string;
  provider_language: string | null;
  normalized_language: string;
  variant_ref: string;
  observed_price: number | null;
  currency: "EUR";
  observed_at: string;
  history_points_30d: Array<{ ts: string; price: number; currency: "EUR" }>;
  history_points_30d_count: number;
  metadata: Record<string, unknown>;
  updated_at: string;
};

type PayloadSummary = {
  rawPayloadId: string;
  providerSetId: string | null;
  cards: number;
  observations: number;
  insertedOrUpdated: number;
};

type ObservationSample = {
  providerSetId: string | null;
  providerCardId: string;
  providerVariantId: string;
  cardName: string;
  cardNumber: string | null;
  normalizedCardNumber: string | null;
  observedPrice: number | null;
  observedAt: string;
  variantRef: string;
};

type RawNormalizeResult = {
  ok: boolean;
  job: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  payloadsRequested: number;
  payloadsScanned: number;
  payloadsProcessed: number;
  payloadsSkippedAlreadyNormalized: number;
  payloadsSkippedNonSuccess: number;
  observationsBuilt: number;
  observationsUpserted: number;
  singleObservations: number;
  sealedObservations: number;
  firstError: string | null;
  samplePayloads: PayloadSummary[];
  sampleObservations: ObservationSample[];
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function parseProviderSetId(params: Record<string, unknown> | null | undefined): string | null {
  const raw = params?.episodeId;
  const value = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  return value || null;
}

function normalizePrice(card: PtcgApiCard): number | null {
  const market = card.prices?.cardmarket;
  const candidates = [market?.lowest_near_mint, market?.["30d_average"], market?.["7d_average"]];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function normalizeCardId(card: PtcgApiCard): string | null {
  const tcgid = String(card.tcgid ?? "").trim();
  if (tcgid) return tcgid;
  const id = String(card.id ?? "").trim();
  return id || null;
}

function buildObservationRow(params: {
  rawPayload: RawPayloadRow;
  providerSetId: string | null;
  card: PtcgApiCard;
  normalizedAt: string;
}): NormalizedObservationRow | null {
  const { rawPayload, providerSetId, card, normalizedAt } = params;
  const providerCardId = normalizeCardId(card);
  if (!providerCardId) return null;
  const providerVariantId = `${providerCardId}_raw_nm_en`;
  const cardNumberRaw = card.card_number == null ? null : String(card.card_number).trim();
  const normalizedCardNumber = cardNumberRaw ? normalizeCardNumber(cardNumberRaw) : null;
  const observedPrice = normalizePrice(card);

  return {
    provider_raw_payload_id: rawPayload.id,
    provider: PROVIDER,
    endpoint: ENDPOINT,
    provider_set_id: providerSetId,
    provider_card_id: providerCardId,
    provider_variant_id: providerVariantId,
    asset_type: "single",
    set_name: null,
    card_name: String(card.name ?? "").trim() || providerCardId,
    card_number: cardNumberRaw,
    normalized_card_number: normalizedCardNumber || null,
    provider_finish: null,
    normalized_finish: "UNKNOWN",
    normalized_edition: "UNLIMITED",
    normalized_stamp: "NONE",
    provider_condition: "Near Mint",
    normalized_condition: "nm",
    provider_language: "English",
    normalized_language: "en",
    variant_ref: buildLegacyVariantRef(
      "normal",
      "UNLIMITED",
      null,
      "Near Mint",
      "English",
      "RAW",
    ),
    observed_price: observedPrice,
    currency: "EUR",
    observed_at: rawPayload.fetched_at,
    history_points_30d: [],
    history_points_30d_count: 0,
    metadata: {
      rawFetchedAt: rawPayload.fetched_at,
      requestHash: rawPayload.request_hash ?? null,
      responseHash: rawPayload.response_hash ?? null,
      providerApiCardId: card.id ?? null,
      providerTcgId: card.tcgid ?? null,
      providerRarity: card.rarity ?? null,
      providerEpisode: card.episode ?? null,
      providerCardmarket: card.prices?.cardmarket ?? null,
    },
    updated_at: normalizedAt,
  };
}

async function loadCandidatePayloads(params: {
  payloadLimit: number;
  providerSetId?: string | null;
  rawPayloadId?: string | null;
  force?: boolean;
}): Promise<{
  payloads: RawPayloadRow[];
  scanned: number;
  skippedAlreadyNormalized: number;
  skippedNonSuccess: number;
}> {
  const supabase = dbAdmin();
  const force = params.force === true || Boolean(params.rawPayloadId);

  if (params.rawPayloadId) {
    let query = supabase
      .from("provider_raw_payloads")
      .select("id, provider, endpoint, params, response, status_code, fetched_at, request_hash, response_hash")
      .eq("id", params.rawPayloadId)
      .eq("provider", PROVIDER)
      .eq("endpoint", ENDPOINT);

    if (params.providerSetId) {
      query = query.contains("params", { episodeId: params.providerSetId });
    }

    const { data, error } = await query.maybeSingle<RawPayloadRow>();
    if (error) throw new Error(`provider_raw_payloads(load rawId): ${error.message}`);
    const row = data ? [data] : [];
    const skippedNonSuccess = row[0] && (row[0].status_code < 200 || row[0].status_code >= 300) ? 1 : 0;
    return {
      payloads: skippedNonSuccess ? [] : row,
      scanned: row.length,
      skippedAlreadyNormalized: 0,
      skippedNonSuccess,
    };
  }

  const selected: RawPayloadRow[] = [];
  let scanned = 0;
  let skippedAlreadyNormalized = 0;
  let skippedNonSuccess = 0;

  for (let from = 0; selected.length < params.payloadLimit; from += RAW_SCAN_PAGE_SIZE) {
    let query = supabase
      .from("provider_raw_payloads")
      .select("id, status_code")
      .eq("provider", PROVIDER)
      .eq("endpoint", ENDPOINT)
      .order("fetched_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + RAW_SCAN_PAGE_SIZE - 1);

    if (params.providerSetId) {
      query = query.contains("params", { episodeId: params.providerSetId });
    }

    const { data, error } = await query;
    if (error) throw new Error(`provider_raw_payloads(load): ${error.message}`);

    const scanRows = (data ?? []) as RawPayloadScanRow[];
    if (scanRows.length === 0) break;
    scanned += scanRows.length;

    let normalizedByPayload = new Set<string>();
    if (!force) {
      const { data: existingRows, error: existingError } = await supabase
        .from("provider_normalized_observations")
        .select("provider_raw_payload_id")
        .in("provider_raw_payload_id", scanRows.map((row) => row.id));

      if (existingError) {
        throw new Error(`provider_normalized_observations(load existing): ${existingError.message}`);
      }

      normalizedByPayload = new Set(
        (existingRows ?? []).map((row) => String((row as { provider_raw_payload_id: string }).provider_raw_payload_id)),
      );
    }

    const selectedIds: string[] = [];
    for (const row of scanRows) {
      if (row.status_code < 200 || row.status_code >= 300) {
        skippedNonSuccess += 1;
        continue;
      }
      if (!force && normalizedByPayload.has(row.id)) {
        skippedAlreadyNormalized += 1;
        continue;
      }
      selectedIds.push(row.id);
      if (selected.length + selectedIds.length >= params.payloadLimit) break;
    }

    if (selectedIds.length > 0) {
      const { data: fullRows, error: fullRowsError } = await supabase
        .from("provider_raw_payloads")
        .select("id, provider, endpoint, params, response, status_code, fetched_at, request_hash, response_hash")
        .in("id", selectedIds);

      if (fullRowsError) {
        throw new Error(`provider_raw_payloads(load selected): ${fullRowsError.message}`);
      }

      const fullRowsById = new Map<string, RawPayloadRow>();
      for (const row of (fullRows ?? []) as RawPayloadRow[]) {
        fullRowsById.set(row.id, row);
      }

      for (const id of selectedIds) {
        const fullRow = fullRowsById.get(id);
        if (!fullRow) continue;
        selected.push(fullRow);
        if (selected.length >= params.payloadLimit) break;
      }
    }
  }

  return {
    payloads: selected,
    scanned,
    skippedAlreadyNormalized,
    skippedNonSuccess,
  };
}

export async function runPokemonTcgRawNormalize(opts: {
  payloadLimit?: number;
  providerSetId?: string | null;
  rawPayloadId?: string | null;
  force?: boolean;
} = {}): Promise<RawNormalizeResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const payloadLimit = parsePositiveInt(opts.payloadLimit, DEFAULT_PAYLOADS_PER_RUN);

  let firstError: string | null = null;
  let payloadsScanned = 0;
  let payloadsSkippedAlreadyNormalized = 0;
  let payloadsSkippedNonSuccess = 0;
  let payloadsProcessed = 0;
  let observationsBuilt = 0;
  let observationsUpserted = 0;
  let singleObservations = 0;
  const sealedObservations = 0;
  const samplePayloads: PayloadSummary[] = [];
  const sampleObservations: ObservationSample[] = [];

  const { data: runRow, error: runStartError } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "pokemontcg",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: {
        mode: "normalize-only",
        payloadLimit,
        providerSetId: opts.providerSetId ?? null,
        rawPayloadId: opts.rawPayloadId ?? null,
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
    const candidateResult = await loadCandidatePayloads({
      payloadLimit,
      providerSetId: opts.providerSetId,
      rawPayloadId: opts.rawPayloadId,
      force: opts.force,
    });

    payloadsScanned = candidateResult.scanned;
    payloadsSkippedAlreadyNormalized = candidateResult.skippedAlreadyNormalized;
    payloadsSkippedNonSuccess = candidateResult.skippedNonSuccess;

    for (const rawPayload of candidateResult.payloads) {
      payloadsProcessed += 1;
      const providerSetId = parseProviderSetId(rawPayload.params);
      const normalizedAt = new Date().toISOString();
      const cards = Array.isArray(rawPayload.response?.data) ? rawPayload.response?.data ?? [] : [];
      const rows: NormalizedObservationRow[] = [];

      for (const card of cards) {
        const row = buildObservationRow({
          rawPayload,
          providerSetId,
          card,
          normalizedAt,
        });
        if (!row) continue;
        rows.push(row);
        observationsBuilt += 1;
        singleObservations += 1;
        if (sampleObservations.length < 12) {
          sampleObservations.push({
            providerSetId: row.provider_set_id,
            providerCardId: row.provider_card_id,
            providerVariantId: row.provider_variant_id,
            cardName: row.card_name,
            cardNumber: row.card_number,
            normalizedCardNumber: row.normalized_card_number,
            observedPrice: row.observed_price,
            observedAt: row.observed_at,
            variantRef: row.variant_ref,
          });
        }
      }

      if (rows.length > 0) {
        const { data, error } = await supabase
          .from("provider_normalized_observations")
          .upsert(rows, {
            onConflict: "provider_raw_payload_id,provider_card_id,provider_variant_id",
          })
          .select("id");

        if (error) {
          throw new Error(`provider_normalized_observations: ${error.message}`);
        }

        observationsUpserted += (data ?? []).length;
      }

      if (samplePayloads.length < 25) {
        samplePayloads.push({
          rawPayloadId: rawPayload.id,
          providerSetId,
          cards: cards.length,
          observations: rows.length,
          insertedOrUpdated: rows.length,
        });
      }
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  const endedAt = new Date().toISOString();
  const result: RawNormalizeResult = {
    ok: firstError === null,
    job: JOB,
    provider: PROVIDER,
    startedAt,
    endedAt,
    payloadsRequested: payloadLimit,
    payloadsScanned,
    payloadsProcessed,
    payloadsSkippedAlreadyNormalized,
    payloadsSkippedNonSuccess,
    observationsBuilt,
    observationsUpserted,
    singleObservations,
    sealedObservations,
    firstError,
    samplePayloads,
    sampleObservations,
  };

  if (runId) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: result.ok,
        items_fetched: observationsBuilt,
        items_upserted: observationsUpserted,
        items_failed: firstError ? 1 : 0,
        ended_at: endedAt,
        meta: {
          mode: "normalize-only",
          payloadLimit,
          providerSetId: opts.providerSetId ?? null,
          rawPayloadId: opts.rawPayloadId ?? null,
          force: opts.force === true,
          payloadsScanned,
          payloadsProcessed,
          payloadsSkippedAlreadyNormalized,
          payloadsSkippedNonSuccess,
          singleObservations,
          sealedObservations,
          samplePayloads,
          sampleObservations,
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}
