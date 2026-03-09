import { dbAdmin } from "@/lib/db/admin";
import { buildLegacyVariantRef, normalizeCondition } from "@/lib/providers/justtcg";
import type { PokeTraceCard } from "@/lib/poketrace/client";

const PROVIDER = "POKETRACE";
const JOB = "poketrace_raw_normalize";
const ENDPOINT = "/cards";
const DEFAULT_PAYLOADS_PER_RUN = process.env.POKETRACE_NORMALIZE_PAYLOADS_PER_RUN
  ? parseInt(process.env.POKETRACE_NORMALIZE_PAYLOADS_PER_RUN, 10)
  : 25;
const RAW_SCAN_PAGE_SIZE = 20;
const PAYLOAD_LOAD_RETRIES = process.env.POKETRACE_NORMALIZE_PAYLOAD_LOAD_RETRIES
  ? parseInt(process.env.POKETRACE_NORMALIZE_PAYLOAD_LOAD_RETRIES, 10)
  : 2;

type RawPayloadRow = {
  id: string;
  provider: string;
  endpoint: string;
  params: Record<string, unknown> | null;
  response: {
    data?: PokeTraceCard[];
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
  currency: "USD" | "EUR" | "JPY";
  observed_at: string;
  history_points_30d: Array<{ ts: string; price: number; currency: "USD" | "EUR" | "JPY" }>;
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

type SelectedPokeTracePrice = {
  providerSource: string;
  providerTier: string;
  providerCondition: string | null;
  normalizedCondition: string;
  price: number | null;
  currency: "USD" | "EUR" | "JPY";
  priceRow: Record<string, unknown>;
  historyPoints30d: Array<{ ts: string; price: number; currency: "USD" | "EUR" | "JPY" }>;
};

type VariantObservation = {
  variantName: string;
  variantId: string;
  observedPrice: number | null;
  currency: "USD" | "EUR" | "JPY";
  providerFinish: string | null;
  normalizedFinish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
  normalizedEdition: "UNLIMITED" | "FIRST_EDITION";
  providerCondition: string | null;
  normalizedCondition: string;
  providerSource: string | null;
  providerTier: string | null;
  historyPoints30d: Array<{ ts: string; price: number; currency: "USD" | "EUR" | "JPY" }>;
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function parseProviderSetId(params: Record<string, unknown> | null | undefined): string | null {
  const raw = params?.set;
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

function normalizeCurrency(raw: unknown): "USD" | "EUR" | "JPY" {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "EUR") return "EUR";
  if (value === "JPY") return "JPY";
  return "USD";
}

function getNumberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizePokeTraceCondition(condition: string | null | undefined): {
  providerCondition: string | null;
  normalizedCondition: string;
} {
  const providerCondition = String(condition ?? "").trim() || null;
  if (!providerCondition) return { providerCondition: null, normalizedCondition: "nm" };
  const humanized = providerCondition.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
  return {
    providerCondition,
    normalizedCondition: normalizeCondition(humanized),
  };
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
  if (lower.includes("nonholo") || lower.includes("normal")) {
    return { providerFinish: variantName, normalizedFinish: "NON_HOLO", normalizedEdition: "UNLIMITED" };
  }
  if (lower.includes("holo") || lower.includes("foil")) {
    return { providerFinish: variantName, normalizedFinish: "HOLO", normalizedEdition: "UNLIMITED" };
  }
  return { providerFinish: variantName, normalizedFinish: "UNKNOWN", normalizedEdition: "UNLIMITED" };
}

const POKETRACE_SOURCE_ORDER = ["tcgplayer", "ebay", "cardmarket"] as const;
const POKETRACE_TIER_ORDER = [
  "NEAR_MINT",
  "MINT",
  "LIGHT_PLAYED",
  "MODERATELY_PLAYED",
  "HEAVY_PLAYED",
  "DAMAGED",
] as const;

function historyAnchorFromAverage(
  observedAt: string,
  lookbackDays: number,
  value: unknown,
  currency: "USD" | "EUR" | "JPY",
): { ts: string; price: number; currency: "USD" | "EUR" | "JPY" } | null {
  const price = getNumberField(value);
  const observedAtMs = Date.parse(observedAt);
  if (price === null || !Number.isFinite(observedAtMs)) return null;
  return {
    ts: new Date(observedAtMs - (lookbackDays * 24 * 60 * 60 * 1000)).toISOString(),
    price,
    currency,
  };
}

function selectPreferredPokeTracePrice(prices: unknown, observedAt: string): SelectedPokeTracePrice | null {
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) return null;
  const priceSources = prices as Record<string, unknown>;

  for (const preferredSource of POKETRACE_SOURCE_ORDER) {
    const sourceRow = priceSources[preferredSource];
    if (!sourceRow || typeof sourceRow !== "object" || Array.isArray(sourceRow)) continue;
    const tiers = sourceRow as Record<string, unknown>;

    for (const preferredTier of POKETRACE_TIER_ORDER) {
      const tierRow = tiers[preferredTier];
      if (!tierRow || typeof tierRow !== "object" || Array.isArray(tierRow)) continue;
      const record = tierRow as Record<string, unknown>;
      const currency = normalizeCurrency(record.currency);
      const price = getNumberField(record.market)
        ?? getNumberField(record.price)
        ?? getNumberField(record.amount)
        ?? getNumberField(record.value)
        ?? getNumberField(record.avg1d)
        ?? getNumberField(record.avg7d)
        ?? getNumberField(record.avg30d);
      const normalizedCondition = normalizePokeTraceCondition(preferredTier);
      const historyPoints30d = [
        historyAnchorFromAverage(observedAt, 1, record.avg1d, currency),
        historyAnchorFromAverage(observedAt, 7, record.avg7d, currency),
        historyAnchorFromAverage(observedAt, 30, record.avg30d, currency),
      ].filter((point): point is { ts: string; price: number; currency: "USD" | "EUR" | "JPY" } => Boolean(point));

      if (price !== null || historyPoints30d.length > 0) {
        return {
          providerSource: preferredSource,
          providerTier: preferredTier,
          providerCondition: normalizedCondition.providerCondition,
          normalizedCondition: normalizedCondition.normalizedCondition,
          price,
          currency,
          priceRow: record,
          historyPoints30d,
        };
      }
    }
  }

  return null;
}

function buildVariantObservations(card: PokeTraceCard, observedAt: string): VariantObservation[] {
  const variantName = String(card.variant ?? card.finish ?? "normal").trim() || "normal";
  const variantId = variantName.replace(/\s+/g, "_").toLowerCase();
  const pricing = selectPreferredPokeTracePrice(card.prices, observedAt);
  const finish = variantNameToFinish(variantName);

  return [{
    variantName,
    variantId,
    observedPrice: pricing?.price ?? null,
    currency: pricing?.currency ?? "USD",
    providerFinish: finish.providerFinish,
    normalizedFinish: finish.normalizedFinish,
    normalizedEdition: finish.normalizedEdition,
    providerCondition: pricing?.providerCondition ?? null,
    normalizedCondition: pricing?.normalizedCondition ?? "nm",
    providerSource: pricing?.providerSource ?? null,
    providerTier: pricing?.providerTier ?? null,
    historyPoints30d: pricing?.historyPoints30d ?? [],
  }];
}

function buildObservationRow(params: {
  rawPayload: RawPayloadRow;
  providerSetId: string | null;
  card: PokeTraceCard;
  variant: VariantObservation;
  normalizedAt: string;
}): NormalizedObservationRow | null {
  const { rawPayload, providerSetId, card, variant, normalizedAt } = params;
  const providerCardId = String(card.id ?? "").trim();
  if (!providerCardId) return null;

  const providerVariantId = `${providerCardId}:${variant.variantId}`;
  const cardNumberRaw = String(card.cardNumber ?? card.number ?? "").trim() || null;
  const normalizedCardNumber = normalizeCardNumber(cardNumberRaw);
  const setName = String(card.set?.name ?? "").trim() || null;
  const providerLanguage = String(card.language ?? "en").trim() || "en";
  const imageUrl = String(card.images?.large ?? card.images?.small ?? card.image ?? "").trim() || null;

  return {
    provider_raw_payload_id: rawPayload.id,
    provider: PROVIDER,
    endpoint: ENDPOINT,
    provider_set_id: providerSetId,
    provider_card_id: providerCardId,
    provider_variant_id: providerVariantId,
    asset_type: "single",
    set_name: setName,
    card_name: String(card.name ?? "").trim() || providerCardId,
    card_number: cardNumberRaw,
    normalized_card_number: normalizedCardNumber || null,
    provider_finish: variant.providerFinish,
    normalized_finish: variant.normalizedFinish,
    normalized_edition: variant.normalizedEdition,
    normalized_stamp: "NONE",
    provider_condition: variant.providerCondition,
    normalized_condition: variant.normalizedCondition,
    provider_language: providerLanguage,
    normalized_language: "en",
    variant_ref: buildLegacyVariantRef(
      variant.variantName,
      variant.normalizedEdition,
      null,
      variant.providerCondition ?? "Near Mint",
      "English",
      "RAW",
    ),
    observed_price: variant.observedPrice,
    currency: variant.currency,
    observed_at: rawPayload.fetched_at,
    history_points_30d: variant.historyPoints30d,
    history_points_30d_count: variant.historyPoints30d.length,
    metadata: {
      rawFetchedAt: rawPayload.fetched_at,
      requestHash: rawPayload.request_hash ?? null,
      responseHash: rawPayload.response_hash ?? null,
      providerCardSlug: card.slug ?? null,
      providerRarity: card.rarity ?? null,
      providerSet: card.set ?? null,
      providerVariant: variant.variantName,
      providerSource: variant.providerSource,
      providerTier: variant.providerTier,
      providerCondition: variant.providerCondition,
      normalizedCondition: variant.normalizedCondition,
      providerImageUrl: imageUrl,
      providerPrices: card.prices ?? null,
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

export async function runPokeTraceRawNormalize(opts: {
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
      source: "poketrace",
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
        const variants = buildVariantObservations(card, rawPayload.fetched_at);
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
        const dedupedRowsByKey = new Map<string, NormalizedObservationRow>();
        for (const row of rows) {
          const key = `${row.provider_raw_payload_id}::${row.provider_card_id}::${row.provider_variant_id}`;
          dedupedRowsByKey.set(key, row);
        }
        const dedupedRows = [...dedupedRowsByKey.values()];

        const { data, error } = await supabase
          .from("provider_normalized_observations")
          .upsert(dedupedRows, {
            onConflict: "provider_raw_payload_id,provider_card_id,provider_variant_id",
          })
          .select("id");

        if (error) {
          const message = String(error.message ?? "");
          const duplicateAffectError = "ON CONFLICT DO UPDATE command cannot affect row a second time";
          if (!message.includes(duplicateAffectError)) {
            throw new Error(`provider_normalized_observations(upsert): ${message}`);
          }

          let fallbackCount = 0;
          for (const row of dedupedRows) {
            const { data: singleData, error: singleError } = await supabase
              .from("provider_normalized_observations")
              .upsert(row, {
                onConflict: "provider_raw_payload_id,provider_card_id,provider_variant_id",
              })
              .select("id");
            if (singleError) {
              throw new Error(`provider_normalized_observations(upsert): ${singleError.message}`);
            }
            fallbackCount += (singleData ?? []).length;
          }
          insertedOrUpdated = fallbackCount;
          observationsUpserted += insertedOrUpdated;
        } else {
          insertedOrUpdated = (data ?? []).length;
          observationsUpserted += insertedOrUpdated;
        }
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
