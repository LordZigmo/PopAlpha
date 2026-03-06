import { dbAdmin } from "@/lib/db/admin";
import { buildLegacyVariantRef } from "@/lib/providers/justtcg";
import type { ScrydexCard, ScrydexVariant } from "@/lib/scrydex/client";

const PROVIDER = "SCRYDEX";
const JOB = "scrydex_raw_normalize";
const ENDPOINT = "/en/expansions/{id}/cards";
const DEFAULT_PAYLOADS_PER_RUN = process.env.SCRYDEX_NORMALIZE_PAYLOADS_PER_RUN
  ? parseInt(process.env.SCRYDEX_NORMALIZE_PAYLOADS_PER_RUN, 10)
  : 50;
const RAW_SCAN_PAGE_SIZE = 20;
const PAYLOAD_LOAD_RETRIES = process.env.SCRYDEX_NORMALIZE_PAYLOAD_LOAD_RETRIES
  ? parseInt(process.env.SCRYDEX_NORMALIZE_PAYLOAD_LOAD_RETRIES, 10)
  : 2;

type RawPayloadRow = {
  id: string;
  provider: string;
  endpoint: string;
  params: Record<string, unknown> | null;
  response: {
    data?: ScrydexCard[];
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
  currency: "USD" | "EUR";
  observed_at: string;
  history_points_30d: Array<{ ts: string; price: number; currency: "USD" | "EUR" }>;
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
  payloadsSkippedLoadError: number;
  observationsBuilt: number;
  observationsUpserted: number;
  singleObservations: number;
  sealedObservations: number;
  firstError: string | null;
  samplePayloads: PayloadSummary[];
  sampleObservations: ObservationSample[];
};

type VariantObservation = {
  variantName: string;
  variantId: string;
  observedPrice: number | null;
  currency: "USD" | "EUR";
  providerFinish: string | null;
  normalizedFinish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
  normalizedEdition: "UNLIMITED" | "FIRST_EDITION";
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function parseProviderSetId(params: Record<string, unknown> | null | undefined): string | null {
  const raw = params?.expansionId;
  const value = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  return value || null;
}

function normalizeCardNumber(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/^#/, "");
  const slashMatch = trimmed.match(/^(\d+)\//);
  if (slashMatch) return String(parseInt(slashMatch[1], 10));
  if (/^\d+$/.test(trimmed)) return String(parseInt(trimmed, 10));
  const promoMatch = trimmed.match(/^([A-Za-z]+)(\d+)$/);
  if (promoMatch) {
    return `${promoMatch[1].toUpperCase()}${String(parseInt(promoMatch[2], 10))}`;
  }
  return trimmed;
}

function variantNameToFinish(variantName: string): {
  providerFinish: string | null;
  normalizedFinish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
  normalizedEdition: "UNLIMITED" | "FIRST_EDITION";
} {
  const lower = variantName.toLowerCase().replace(/[-_]+/g, "").trim();
  if (!lower) {
    return { providerFinish: null, normalizedFinish: "UNKNOWN", normalizedEdition: "UNLIMITED" };
  }
  if (lower.includes("1stedition") || lower.includes("firstedition")) {
    return { providerFinish: variantName, normalizedFinish: "HOLO", normalizedEdition: "FIRST_EDITION" };
  }
  if (lower.includes("reverse")) {
    return { providerFinish: variantName, normalizedFinish: "REVERSE_HOLO", normalizedEdition: "UNLIMITED" };
  }
  if (lower === "normal" || lower === "nonholo" || lower === "nonholofoil") {
    return { providerFinish: variantName, normalizedFinish: "NON_HOLO", normalizedEdition: "UNLIMITED" };
  }
  if (lower.includes("holo") || lower.includes("foil")) {
    return { providerFinish: variantName, normalizedFinish: "HOLO", normalizedEdition: "UNLIMITED" };
  }
  if (lower === "unknown") {
    return { providerFinish: variantName, normalizedFinish: "UNKNOWN", normalizedEdition: "UNLIMITED" };
  }
  return { providerFinish: variantName, normalizedFinish: "UNKNOWN", normalizedEdition: "UNLIMITED" };
}

function getNumberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function extractPriceCurrency(prices: unknown): { price: number | null; currency: "USD" | "EUR" } {
  if (!prices || typeof prices !== "object") return { price: null, currency: "USD" };
  const record = prices as Record<string, unknown>;

  const directCurrency = typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
  const directCandidates = [
    record.marketPrice,
    record.market,
    record.lowest_near_mint,
    record.low,
    record.mid,
    record.average,
    record.avg,
    record.price,
    record.value,
  ];
  for (const candidate of directCandidates) {
    const value = getNumberField(candidate);
    if (value !== null) {
      return {
        price: value,
        currency: directCurrency === "EUR" ? "EUR" : "USD",
      };
    }
  }

  const usdValue = getNumberField(record.usd) ?? getNumberField(record.USD);
  if (usdValue !== null) return { price: usdValue, currency: "USD" };

  const eurValue = getNumberField(record.eur) ?? getNumberField(record.EUR);
  if (eurValue !== null) return { price: eurValue, currency: "EUR" };

  for (const value of Object.values(record)) {
    if (!value || typeof value !== "object") continue;
    const nested = extractPriceCurrency(value);
    if (nested.price !== null) return nested;
  }

  return { price: null, currency: "USD" };
}

function buildVariantObservations(card: ScrydexCard): VariantObservation[] {
  const fallbackPrice = extractPriceCurrency((card as { prices?: unknown }).prices);
  const variants = card.variants ?? [];
  if (variants.length === 0) {
    const fallbackFinish = variantNameToFinish("unknown");
    return [{
      variantName: "unknown",
      variantId: "unknown",
      observedPrice: fallbackPrice.price,
      currency: fallbackPrice.currency,
      providerFinish: fallbackFinish.providerFinish,
      normalizedFinish: fallbackFinish.normalizedFinish,
      normalizedEdition: fallbackFinish.normalizedEdition,
    }];
  }

  const results: VariantObservation[] = [];
  for (const variant of variants) {
    const variantName = String((variant as ScrydexVariant).name ?? "unknown").trim() || "unknown";
    const variantId = variantName.replace(/\s+/g, "_").toLowerCase();
    const pricing = extractPriceCurrency((variant as ScrydexVariant).prices);
    const finish = variantNameToFinish(variantName);
    results.push({
      variantName,
      variantId,
      observedPrice: pricing.price ?? fallbackPrice.price,
      currency: pricing.price !== null ? pricing.currency : fallbackPrice.currency,
      providerFinish: finish.providerFinish,
      normalizedFinish: finish.normalizedFinish,
      normalizedEdition: finish.normalizedEdition,
    });
  }

  return results;
}

function buildObservationRow(params: {
  rawPayload: RawPayloadRow;
  providerSetId: string | null;
  card: ScrydexCard;
  variant: VariantObservation;
  normalizedAt: string;
}): NormalizedObservationRow | null {
  const { rawPayload, providerSetId, card, variant, normalizedAt } = params;
  const providerCardId = String(card.id ?? "").trim();
  if (!providerCardId) return null;

  const providerVariantId = `${providerCardId}:${variant.variantId}`;
  const cardNumberRaw = String(card.number ?? card.printed_number ?? "").trim() || null;
  const normalizedCardNumber = normalizeCardNumber(cardNumberRaw);

  return {
    provider_raw_payload_id: rawPayload.id,
    provider: PROVIDER,
    endpoint: ENDPOINT,
    provider_set_id: providerSetId,
    provider_card_id: providerCardId,
    provider_variant_id: providerVariantId,
    asset_type: "single",
    set_name: card.expansion?.name?.trim() ?? null,
    card_name: String(card.name ?? "").trim() || providerCardId,
    card_number: cardNumberRaw,
    normalized_card_number: normalizedCardNumber || null,
    provider_finish: variant.providerFinish,
    normalized_finish: variant.normalizedFinish,
    normalized_edition: variant.normalizedEdition,
    normalized_stamp: "NONE",
    provider_condition: "Near Mint",
    normalized_condition: "nm",
    provider_language: card.language_code ?? "en",
    normalized_language: "en",
    variant_ref: buildLegacyVariantRef(
      variant.variantName,
      variant.normalizedEdition,
      null,
      "Near Mint",
      "English",
      "RAW",
    ),
    observed_price: variant.observedPrice,
    currency: variant.currency,
    observed_at: rawPayload.fetched_at,
    history_points_30d: [],
    history_points_30d_count: 0,
    metadata: {
      rawFetchedAt: rawPayload.fetched_at,
      requestHash: rawPayload.request_hash ?? null,
      responseHash: rawPayload.response_hash ?? null,
      providerCardId: card.id ?? null,
      providerRarity: card.rarity ?? null,
      providerExpansion: card.expansion ?? null,
      providerVariant: variant.variantName,
      providerVariantPricingCurrency: variant.currency,
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
      query = query.contains("params", { expansionId: params.providerSetId });
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
      query = query.contains("params", { expansionId: params.providerSetId });
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
  let payloadsSkippedLoadError = 0;
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
      source: "scrydex",
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

    const nowIso = new Date().toISOString();

    for (const rawPayload of candidateResult.payloads) {
      payloadsProcessed += 1;
      const providerSetId = parseProviderSetId(rawPayload.params);
      const cards = rawPayload.response?.data ?? [];
      const rows: NormalizedObservationRow[] = [];

      for (const card of cards) {
        const variants = buildVariantObservations(card);
        for (const variant of variants) {
          const observation = buildObservationRow({
            rawPayload,
            providerSetId,
            card,
            variant,
            normalizedAt: nowIso,
          });
          if (!observation) continue;

          rows.push(observation);
          observationsBuilt += 1;
          singleObservations += 1;

          if (sampleObservations.length < 25) {
            sampleObservations.push({
              providerSetId,
              providerCardId: observation.provider_card_id,
              providerVariantId: observation.provider_variant_id,
              cardName: observation.card_name,
              cardNumber: observation.card_number,
              normalizedCardNumber: observation.normalized_card_number,
              observedPrice: observation.observed_price,
              observedAt: observation.observed_at,
              variantRef: observation.variant_ref,
            });
          }
        }
      }

      let insertedOrUpdated = 0;
      if (rows.length > 0) {
        const { data, error } = await supabase
          .from("provider_normalized_observations")
          .upsert(rows, {
            onConflict: "provider,provider_variant_id,provider_raw_payload_id",
          })
          .select("id");

        if (error) {
          throw new Error(`provider_normalized_observations(upsert): ${error.message}`);
        }
        insertedOrUpdated = (data ?? []).length;
        observationsUpserted += insertedOrUpdated;
      }

      if (samplePayloads.length < 25) {
        samplePayloads.push({
          rawPayloadId: rawPayload.id,
          providerSetId,
          cards: cards.length,
          observations: rows.length,
          insertedOrUpdated,
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
        items_failed: payloadsSkippedNonSuccess + (firstError ? 1 : 0),
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
          observationsBuilt,
          observationsUpserted,
          samplePayloads,
          sampleObservations,
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}
