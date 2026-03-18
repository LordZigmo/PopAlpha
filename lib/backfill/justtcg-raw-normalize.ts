import { dbAdmin } from "@/lib/db/admin";
import { ensureProviderRawPayloadLineageId } from "@/lib/backfill/provider-raw-payload-lineage";
import { retrySupabaseWriteOperation } from "@/lib/backfill/supabase-write-retry";
import {
  buildLegacyVariantRef,
  classifyJustTcgCard,
  extractJustTcgVariantAnalytics,
  mapJustTcgPrinting,
  normalizeCardNumber,
  normalizeCondition,
  normalizeJustTcgEpochToIso,
  type JustTcgCard,
  type JustTcgVariant,
} from "@/lib/providers/justtcg";

const PROVIDER = "JUSTTCG";
const JOB = "justtcg_raw_normalize";
const ENDPOINT = "/cards";
const DEFAULT_PAYLOADS_PER_RUN = process.env.JUSTTCG_NORMALIZE_PAYLOADS_PER_RUN
  ? parseInt(process.env.JUSTTCG_NORMALIZE_PAYLOADS_PER_RUN, 10)
  : 50;
const RAW_SCAN_PAGE_SIZE = 20;
const PAYLOAD_LOAD_RETRIES = process.env.JUSTTCG_NORMALIZE_PAYLOAD_LOAD_RETRIES
  ? parseInt(process.env.JUSTTCG_NORMALIZE_PAYLOAD_LOAD_RETRIES, 10)
  : 2;

type RawPayloadRow = {
  id: string;
  provider: string;
  endpoint: string;
  params: Record<string, unknown> | null;
  response: {
    data?: JustTcgCard[];
    meta?: Record<string, unknown> | null;
    _metadata?: Record<string, unknown> | null;
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

type NormalizedHistoryPoint = {
  ts: string;
  price: number;
  currency: "USD";
};

type NormalizedObservationRow = {
  provider_raw_payload_id: string;
  provider_raw_payload_lineage_id: string;
  provider: string;
  endpoint: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  asset_type: "single" | "sealed";
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
  currency: "USD";
  observed_at: string;
  history_points_30d: NormalizedHistoryPoint[];
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
  assetType: "single" | "sealed";
  cardName: string;
  cardNumber: string | null;
  normalizedCardNumber: string | null;
  providerFinish: string | null;
  normalizedFinish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
  normalizedEdition: "UNLIMITED" | "FIRST_EDITION";
  normalizedStamp: "NONE" | "POKEMON_CENTER";
  providerCondition: string | null;
  normalizedCondition: string;
  providerLanguage: string | null;
  normalizedLanguage: string;
  observedPrice: number | null;
  observedAt: string;
  variantRef: string;
  historyPoints30dCount: number;
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
  payloadsSkippedLoadError: number;
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
  const raw = params?.set;
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || null;
}

function normalizeObservationCardNumber(card: JustTcgCard, assetType: "single" | "sealed"): string | null {
  if (assetType === "sealed") return null;
  const normalized = normalizeCardNumber(card.number);
  if (!normalized || normalized.toUpperCase() === "N/A") return null;
  return normalized;
}

function normalizeObservationPrice(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

function normalizeObservationLanguage(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value === "english") return "en";
  if (value === "japanese") return "jp";
  if (value === "korean") return "kr";
  if (value === "french") return "fr";
  if (value === "german") return "de";
  if (value === "spanish") return "es";
  if (value === "italian") return "it";
  if (value === "portuguese") return "pt";
  return value.replace(/\s+/g, "_");
}

function detectFirstEditionSignal(card: JustTcgCard, variant: JustTcgVariant): boolean {
  const detailsText = card.details == null
    ? ""
    : typeof card.details === "string"
      ? card.details
      : JSON.stringify(card.details);
  const values = [
    card.name,
    card.id,
    card.set_name,
    detailsText,
    variant.printing,
  ];

  return values.some((value) => /\b1st edition\b/i.test(String(value ?? ""))
    || /\bfirst edition\b/i.test(String(value ?? ""))
    || /\b1st[-\s]?ed(?:ition)?\b/i.test(String(value ?? "")));
}

function detectPokemonCenterSignal(card: JustTcgCard): boolean {
  const detailsText = card.details == null
    ? ""
    : typeof card.details === "string"
      ? card.details
      : JSON.stringify(card.details);
  const values = [
    card.name,
    card.id,
    card.set_name,
    detailsText,
  ];

  return values.some((value) => /\bpokemon center\b/i.test(String(value ?? ""))
    || /\bpokemon-center\b/i.test(String(value ?? ""))
    || /\bpokemoncenter\b/i.test(String(value ?? "")));
}

function normalizeObservationEdition(card: JustTcgCard, variant: JustTcgVariant): "UNLIMITED" | "FIRST_EDITION" {
  if (detectFirstEditionSignal(card, variant)) return "FIRST_EDITION";
  return "UNLIMITED";
}

function normalizeObservationStamp(card: JustTcgCard): "NONE" | "POKEMON_CENTER" {
  if (detectPokemonCenterSignal(card)) return "POKEMON_CENTER";
  return "NONE";
}

function stampLabelFromNormalizedStamp(normalizedStamp: "NONE" | "POKEMON_CENTER"): string | null {
  if (normalizedStamp === "POKEMON_CENTER") return "pokemon center";
  return null;
}

function buildNormalizedHistoryPoints(variant: JustTcgVariant): NormalizedHistoryPoint[] {
  const preferred = (variant.priceHistory?.length ?? 0) > 0
    ? variant.priceHistory ?? []
    : variant.priceHistory30d ?? [];

  const rows: NormalizedHistoryPoint[] = [];
  for (const point of preferred) {
    if (!point || typeof point.p !== "number" || !Number.isFinite(point.p) || point.p <= 0) continue;
    const ts = normalizeJustTcgEpochToIso(point.t);
    if (!ts) continue;
    rows.push({
      ts,
      price: point.p,
      currency: "USD",
    });
  }

  rows.sort((left, right) => left.ts.localeCompare(right.ts));
  return rows;
}

function buildObservationRow(params: {
  rawPayload: RawPayloadRow;
  providerRawPayloadLineageId: string;
  providerSetId: string | null;
  card: JustTcgCard;
  variant: JustTcgVariant;
  assetType: "single" | "sealed";
  normalizedAt: string;
}): NormalizedObservationRow | null {
  const { rawPayload, providerRawPayloadLineageId, providerSetId, card, variant, assetType, normalizedAt } = params;
  const providerCardId = String(card.id ?? "").trim();
  const providerVariantId = String(variant.id ?? "").trim();
  if (!providerCardId || !providerVariantId) return null;

  const normalizedCondition = normalizeCondition(variant.condition ?? "");
  const normalizedFinish = mapJustTcgPrinting(variant.printing ?? "");
  const normalizedEdition = normalizeObservationEdition(card, variant);
  const normalizedStamp = normalizeObservationStamp(card);
  const normalizedLanguage = normalizeObservationLanguage(variant.language);
  const observedAt = normalizeJustTcgEpochToIso(variant.lastUpdated ?? null) ?? rawPayload.fetched_at;
  const historyPoints = buildNormalizedHistoryPoints(variant);
  const fallbackProviderSetId = String(card.set ?? "").trim() || null;
  const analytics = extractJustTcgVariantAnalytics(variant);

  return {
    provider_raw_payload_id: rawPayload.id,
    provider_raw_payload_lineage_id: providerRawPayloadLineageId,
    provider: PROVIDER,
    endpoint: ENDPOINT,
    provider_set_id: providerSetId ?? fallbackProviderSetId,
    provider_card_id: providerCardId,
    provider_variant_id: providerVariantId,
    asset_type: assetType,
    set_name: card.set_name?.trim() || null,
    card_name: String(card.name ?? "").trim() || providerCardId,
    card_number: card.number?.trim() || null,
    normalized_card_number: normalizeObservationCardNumber(card, assetType),
    provider_finish: variant.printing?.trim() || null,
    normalized_finish: normalizedFinish,
    normalized_edition: normalizedEdition,
    normalized_stamp: normalizedStamp,
    provider_condition: variant.condition?.trim() || null,
    normalized_condition: normalizedCondition,
    provider_language: variant.language?.trim() || null,
    normalized_language: normalizedLanguage,
    variant_ref: buildLegacyVariantRef(
      assetType === "sealed" ? "sealed" : (variant.printing ?? "normal"),
      normalizedEdition,
      stampLabelFromNormalizedStamp(normalizedStamp),
      variant.condition ?? "",
      variant.language ?? "English",
      "RAW",
    ),
    observed_price: normalizeObservationPrice(variant.price),
    currency: "USD",
    observed_at: observedAt,
    history_points_30d: historyPoints,
    history_points_30d_count: historyPoints.length,
    metadata: {
      rawFetchedAt: rawPayload.fetched_at,
      requestHash: rawPayload.request_hash ?? null,
      responseHash: rawPayload.response_hash ?? null,
      providerCardSetId: card.set ?? null,
      providerCardSetName: card.set_name ?? null,
      providerCardNumber: card.number ?? null,
      providerRarity: card.rarity ?? null,
      providerTcgplayerId: card.tcgplayerId ?? null,
      providerTcgplayerSkuId: variant.tcgplayerSkuId ?? null,
      providerPageMeta: rawPayload.response?.meta ?? null,
      providerEnvelopeMeta: rawPayload.response?._metadata ?? null,
      historyFieldUsed: (variant.priceHistory?.length ?? 0) > 0 ? "priceHistory" : "priceHistory30d",
      providerAnalytics: analytics,
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
  skippedLoadError: number;
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
      query = query.contains("params", { set: params.providerSetId });
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
      skippedLoadError: 0,
    };
  }

  const selected: RawPayloadRow[] = [];
  let scanned = 0;
  let skippedAlreadyNormalized = 0;
  let skippedNonSuccess = 0;
  let skippedLoadError = 0;

  function isRetryableLoadError(message: string): boolean {
    const text = message.toLowerCase();
    return (
      text.includes("statement timeout")
      || text.includes("canceling statement")
      || text.includes("web server is down")
      || text.includes("error code 521")
      || text.includes("fetch failed")
      || text.includes("connection")
    );
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

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
      query = query.contains("params", { set: params.providerSetId });
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
      for (const id of selectedIds) {
        let fullRow: RawPayloadRow | null = null;
        let lastError: string | null = null;

        for (let attempt = 0; attempt <= PAYLOAD_LOAD_RETRIES; attempt += 1) {
          const { data: loadedRow, error: loadError } = await supabase
            .from("provider_raw_payloads")
            .select("id, provider, endpoint, params, response, status_code, fetched_at, request_hash, response_hash")
            .eq("id", id)
            .eq("provider", PROVIDER)
            .eq("endpoint", ENDPOINT)
            .maybeSingle<RawPayloadRow>();

          if (!loadError) {
            fullRow = loadedRow ?? null;
            break;
          }

          lastError = loadError.message ?? "unknown load error";
          if (!isRetryableLoadError(lastError) || attempt >= PAYLOAD_LOAD_RETRIES) break;
          await sleep(150 * (attempt + 1));
        }

        if (!fullRow && lastError) {
          skippedLoadError += 1;
          continue;
        }
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
    skippedLoadError,
  };
}

export async function runJustTcgRawNormalize(opts: {
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
  let payloadsSkippedLoadError = 0;
  let payloadsProcessed = 0;
  let observationsBuilt = 0;
  let observationsUpserted = 0;
  let singleObservations = 0;
  let sealedObservations = 0;
  const samplePayloads: PayloadSummary[] = [];
  const sampleObservations: ObservationSample[] = [];

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
    payloadsSkippedLoadError = candidateResult.skippedLoadError;

    for (const rawPayload of candidateResult.payloads) {
      payloadsProcessed += 1;
      const providerSetId = parseProviderSetId(rawPayload.params);
      const normalizedAt = new Date().toISOString();
      const cards = Array.isArray(rawPayload.response?.data) ? rawPayload.response?.data ?? [] : [];
      const providerRawPayloadLineageId = await ensureProviderRawPayloadLineageId(supabase, rawPayload.id);
      const rows: NormalizedObservationRow[] = [];

      for (const card of cards) {
        const assetType = classifyJustTcgCard(card);
        for (const variant of card.variants ?? []) {
          const row = buildObservationRow({
            rawPayload,
            providerRawPayloadLineageId,
            providerSetId,
            card,
            variant,
            assetType,
            normalizedAt,
          });
          if (!row) continue;
          rows.push(row);
          observationsBuilt += 1;
          if (assetType === "sealed") sealedObservations += 1;
          else singleObservations += 1;
          if (sampleObservations.length < 12) {
            sampleObservations.push({
              providerSetId: row.provider_set_id,
              providerCardId: row.provider_card_id,
              providerVariantId: row.provider_variant_id,
              assetType: row.asset_type,
              cardName: row.card_name,
              cardNumber: row.card_number,
              normalizedCardNumber: row.normalized_card_number,
              providerFinish: row.provider_finish,
              normalizedFinish: row.normalized_finish,
              normalizedEdition: row.normalized_edition,
              normalizedStamp: row.normalized_stamp,
              providerCondition: row.provider_condition,
              normalizedCondition: row.normalized_condition,
              providerLanguage: row.provider_language,
              normalizedLanguage: row.normalized_language,
              observedPrice: row.observed_price,
              observedAt: row.observed_at,
              variantRef: row.variant_ref,
              historyPoints30dCount: row.history_points_30d_count,
            });
          }
        }
      }

      if (rows.length > 0) {
        const data = await retrySupabaseWriteOperation(
          "provider_normalized_observations(upsert)",
          async () => {
            const { data, error } = await supabase
              .from("provider_normalized_observations")
              .upsert(rows, {
                onConflict: "provider_raw_payload_lineage_id,provider_card_id,provider_variant_id",
              })
              .select("id");

            if (error) throw new Error(error.message);
            return (data ?? []) as Array<{ id: string }>;
          },
        );

        observationsUpserted += data.length;
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
    payloadsSkippedLoadError,
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
          payloadsSkippedLoadError,
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
