import { dbAdmin } from "@/lib/db/admin";
import { ensureProviderRawPayloadLineageId } from "@/lib/backfill/provider-raw-payload-lineage";
import { retrySupabaseWriteOperation } from "@/lib/backfill/supabase-write-retry";
import { normalizeCondition } from "@/lib/pricing/normalize-condition";
import {
  parseScrydexVariantSemantics,
  type ScrydexNormalizedEdition,
  type ScrydexNormalizedFinish,
} from "@/lib/backfill/scrydex-variant-semantics";

/**
 * Map Scrydex language_code to our canonical two-letter language tag used in
 * card_printings.language and provider_observation_matches matching keys.
 * Mirrors normalizeLanguageToCanonical in pokemontcg-normalized-match.ts.
 * Defaults to "EN" when the field is absent so existing EN-only behavior is
 * unchanged for sets that don't carry a language_code.
 */
function normalizeProviderLanguageToCanonical(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") return "EN";
  if (normalized === "en") return "EN";
  if (normalized === "jp" || normalized === "ja") return "JP";
  if (normalized === "kr" || normalized === "ko") return "KR";
  if (normalized === "fr") return "FR";
  if (normalized === "de") return "DE";
  if (normalized === "es") return "ES";
  if (normalized === "it") return "IT";
  if (normalized === "pt") return "PT";
  return normalized.toUpperCase();
}

/**
 * Pick the language label used in legacy variant_ref strings. Maps the
 * canonical two-letter tag back to the long form Scrydex/JustTCG used
 * historically so legacy variant_refs stay consistent ("English",
 * "Japanese"). Anything we haven't seen before falls back to the
 * two-letter tag uppercase.
 */
function variantRefLanguageLabel(canonicalLanguage: string): string {
  switch (canonicalLanguage) {
    case "EN": return "English";
    case "JP": return "Japanese";
    case "KR": return "Korean";
    case "FR": return "French";
    case "DE": return "German";
    case "ES": return "Spanish";
    case "IT": return "Italian";
    case "PT": return "Portuguese";
    default: return canonicalLanguage;
  }
}

// Inlined from the retired lib/providers/justtcg.ts. buildLegacyVariantRef
// is the legacy 6-segment variant_ref format used for rows that predate the
// printing_id-based identity. Only this file calls it, so there's no value
// in a shared helper module.
const LANGUAGE_ABBREV: Record<string, string> = {
  "english": "en",
  "japanese": "jp",
  "korean": "kr",
  "french": "fr",
  "german": "de",
  "spanish": "es",
  "italian": "it",
  "portuguese": "pt",
};

const EDITION_NORM: Record<string, string> = {
  "first_edition": "1st-edition",
  "unlimited":     "unlimited",
  "unknown":       "unknown",
};

function normalizeEdition(edition: string): string {
  const key = edition.toLowerCase().replace(/[\s-]+/g, "_");
  return EDITION_NORM[key] ?? "unknown";
}

function normalizeStamp(stamp: string | null): string {
  if (!stamp) return "none";
  return stamp
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "none";
}

function buildLegacyVariantRef(
  printing: string,
  edition: string,
  stamp: string | null,
  condition: string,
  language: string,
  grade: string,
): string {
  const printingNorm  = printing.toLowerCase().replace(/\s+/g, "_");
  const editionNorm   = normalizeEdition(edition);
  const stampNorm     = normalizeStamp(stamp);
  const conditionNorm = normalizeCondition(condition);
  const langKey       = language.toLowerCase().trim();
  const languageNorm  = LANGUAGE_ABBREV[langKey] ?? langKey.replace(/\s+/g, "_");
  const gradeNorm     = grade.toLowerCase();
  return `${printingNorm}:${editionNorm}:${stampNorm}:${conditionNorm}:${languageNorm}:${gradeNorm}`;
}
import {
  getNumberField,
  selectPreferredScrydexPriceEntry,
  selectScrydexGradedEntries,
} from "@/lib/backfill/scrydex-raw-price-select";
import { convertToUsd } from "@/lib/pricing/fx";
// TODO: re-enable after debugging pipeline failures
// import {
//   selectAllScrydexConditionPrices,
//   type ConditionPriceEntry,
// } from "@/lib/backfill/scrydex-condition-price-extract";
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
  provider_raw_payload_lineage_id: string;
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
  normalized_finish: ScrydexNormalizedFinish;
  normalized_edition: ScrydexNormalizedEdition;
  normalized_stamp: string;
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

type VariantObservation = {
  variantName: string;
  variantId: string;
  observedPrice: number | null;
  currency: "USD" | "EUR" | "JPY";
  // Phase C-2 (2026-05-16): Scrydex's `market` field, USD-converted.
  // Headline `observedPrice` after Phase A is scrydex's `low` (matches
  // TCGplayer's published Market Price label, which is sold-anchored).
  // `askingPriceUsd` preserves the asking-anchored value so the card
  // detail page can render "Asking: $X" alongside the headline. This is
  // the spread on thin-liquidity cards (Mewtwo VSTAR JP: low ~$29 vs
  // market ~$50). NULL on graded observations or when scrydex's row
  // lacks a `market` value.
  askingPriceUsd: number | null;
  providerFinish: string | null;
  normalizedFinish: ScrydexNormalizedFinish;
  normalizedEdition: ScrydexNormalizedEdition;
  normalizedStamp: string;
  stampLabel: string | null;
  hasSpecialVariantToken: boolean;
  specialVariantToken: string | null;
  providerCondition: string | null;
  normalizedCondition: string;
  trendAnchorPoints: TrendAnchorPoint[];
  // Graded-specific fields (absent or "RAW" for raw observations)
  grade: string;
  gradedProvider: string | null;
  gradedBucket: string | null;
  isPerfect: boolean;
  lowPrice: number | null;
  highPrice: number | null;
};

// Anchor-tagged source_window values. Phase C-3 (2026-05-16) re-enables
// trend anchors with explicit basis tagging so chart consumers can
// distinguish them from low-basis snapshots:
//   * "snapshot"           — written by the timeseries snapshot path,
//                            uses scrydex's `low` (Phase A headline).
//   * "market_anchor_30d"  — synthetic 30d-window anchor derived from
//                            scrydex's market-basis trend deltas.
//   * "market_anchor_180d" — same, 180d window.
// The chart should filter `source_window = 'snapshot'` for the headline
// price line. Metrics paths read from observation `history_points_30d`
// directly (separate column) and don't need to filter.
type AnchorSourceWindow = "market_anchor_30d" | "market_anchor_180d";

type TrendAnchorPoint = {
  lookbackDays: number;
  price: number;
  currency: "USD" | "EUR" | "JPY";
  sourceWindow: AnchorSourceWindow;
};

const SCRYDEX_TREND_WINDOWS: Array<{
  key: string;
  lookbackDays: number;
  sourceWindow: AnchorSourceWindow;
}> = [
  { key: "days_1", lookbackDays: 1, sourceWindow: "market_anchor_30d" },
  { key: "days_7", lookbackDays: 7, sourceWindow: "market_anchor_30d" },
  { key: "days_14", lookbackDays: 14, sourceWindow: "market_anchor_30d" },
  { key: "days_30", lookbackDays: 30, sourceWindow: "market_anchor_30d" },
  { key: "days_90", lookbackDays: 90, sourceWindow: "market_anchor_180d" },
  { key: "days_180", lookbackDays: 180, sourceWindow: "market_anchor_180d" },
];

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

function extractTrendAnchorPoints(_prices: unknown): TrendAnchorPoint[] {
  // Stays disabled, even with the basis tagging proposed in the first
  // pass of Phase C-3 (Codex P1 on PR #100).
  //
  // First pass attempted: tag anchors with sourceWindow =
  // "market_anchor_30d" / "market_anchor_180d" so the chart view could
  // filter them out from the headline (low-basis) series while metrics
  // still consumed them via observation.history_points_30d.
  //
  // Codex correctly pointed out that the metrics path is also basis-
  // sensitive: derivePriceRelativeTo30dRange compares observedPrice
  // (low) against the historic range computed from anchors (market) —
  // mixed basis, meaningless. The other metrics distorted similarly.
  // Writing anchors that no consumer can correctly use is pure waste.
  //
  // What this PR DOES still ship: the public_price_history_by_printing
  // view tightens to `source_window = 'snapshot'` only, which removes
  // leftover pre-Phase-A '30d' anchor rows from the chart. Those rows
  // were the source of the original phantom-drop bug Phase A's
  // disable patched around. With the view narrowing they're filtered
  // at read time even though they still exist in price_history_points
  // until 90-day retention prunes them.
  //
  // Future PR could re-add anchors if/when there's a consumer wired
  // up that wants the market-basis series explicitly (e.g., a separate
  // "historical asking pressure" chart panel with its own scale). Until
  // then, anchors stay off. AnchorSourceWindow / SCRYDEX_TREND_WINDOWS
  // remain in the file as documentation for that future consumer.
  return [];
}

/**
 * Compute the asking-anchored USD value for a raw pricing selection.
 * Pulls scrydex's `market` field (asking-weighted) off the selected row
 * and converts to USD via the same FX path the headline observation
 * uses. Returns null when `market` is absent or non-positive — graded
 * paths and rows without a market value just don't get an asking line
 * on the card detail surface.
 *
 * Phase C-2 (2026-05-16): introduces "Asking: $X" auxiliary line on
 * card detail. The headline price (after Phase A) tracks scrydex `low`
 * to match TCGplayer's published Market Price label; this helper
 * preserves the asking value scrydex's `market` field carries so we
 * can surface both numbers and the spread.
 */
function extractAskingPriceUsd(
  selection: ReturnType<typeof selectPreferredScrydexPriceEntry>,
): number | null {
  if (!selection) return null;
  const market = getNumberField((selection.row as Record<string, unknown>).market);
  if (market === null) return null;
  const usd = convertToUsd(market, selection.currency);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return Number(usd.toFixed(4));
}

function buildVariantObservations(card: ScrydexCard): VariantObservation[] {
  // Price is selected ONLY from per-variant Scrydex `prices` arrays. We no longer
  // substitute the card-level `prices` as a fallback — on commons where Scrydex
  // has no raw NM data, that fallback was pulling graded (PSA 10) prices into
  // `observed_price` and tagging them as Near Mint. If a variant has no
  // qualifying raw NM/Mint entry we skip the observation for that variant this
  // cycle; carry-forward via existing snapshots handles the stale window.
  //
  // Additionally, we now extract graded entries (PSA/CGC/BGS/TAG) and emit one
  // observation per (variant × provider × gradeBucket). These use a distinct
  // provider_variant_id suffix (::GRADED::<PROVIDER>::<BUCKET>) to avoid
  // collisions on the provider_normalized_observations unique index.
  const variants = card.variants ?? [];
  const results: VariantObservation[] = [];

  // EN-RAW headline tracks scrydex `market` (sold-anchored, mirrors the
  // PriceCharting trusted feed); JP/other keeps `low`. The per-condition
  // `low` field episodically latches onto a junk listing in either
  // direction for EN — see parseScrydexPriceObject docs + lockstep mirror
  // in scrydex-price-history.ts. preferLow=true for everything non-EN.
  const preferLow = normalizeProviderLanguageToCanonical(card.language_code) !== "EN";

  const RAW_DEFAULTS = {
    grade: "RAW" as const,
    gradedProvider: null,
    gradedBucket: null,
    isPerfect: false,
    lowPrice: null,
    highPrice: null,
  };

  if (variants.length === 0) {
    const prices = (card as { prices?: unknown }).prices;
    const pricingSelection = selectPreferredScrydexPriceEntry(prices, { preferLow });
    if (pricingSelection) {
      const semantics = parseScrydexVariantSemantics("unknown");
      results.push({
        variantName: "unknown",
        variantId: "unknown",
        observedPrice: pricingSelection.price,
        currency: pricingSelection.currency,
        askingPriceUsd: extractAskingPriceUsd(pricingSelection),
        providerFinish: semantics.providerFinish,
        normalizedFinish: semantics.normalizedFinish,
        normalizedEdition: semantics.normalizedEdition,
        normalizedStamp: semantics.normalizedStamp,
        stampLabel: semantics.stampLabel,
        hasSpecialVariantToken: semantics.hasSpecialVariantToken,
        specialVariantToken: semantics.specialVariantToken,
        providerCondition: pricingSelection.providerCondition,
        normalizedCondition: pricingSelection.normalizedCondition,
        trendAnchorPoints: extractTrendAnchorPoints(prices),
        ...RAW_DEFAULTS,
      });
    }
    // Also extract graded entries from card-level prices
    for (const graded of selectScrydexGradedEntries(prices)) {
      const semantics = parseScrydexVariantSemantics("unknown");
      results.push({
        variantName: "unknown",
        variantId: "unknown",
        observedPrice: graded.price,
        currency: graded.currency,
        // Graded SKUs intentionally don't carry asking-anchored value:
        // the headline (selectScrydexGradedEntries) keeps scrydex's
        // `market` as the conventional value. See parseScrydexPriceObject
        // docs in scrydex-raw-price-select.ts.
        askingPriceUsd: null,
        providerFinish: semantics.providerFinish,
        normalizedFinish: semantics.normalizedFinish,
        normalizedEdition: semantics.normalizedEdition,
        normalizedStamp: semantics.normalizedStamp,
        stampLabel: semantics.stampLabel,
        hasSpecialVariantToken: semantics.hasSpecialVariantToken,
        specialVariantToken: semantics.specialVariantToken,
        providerCondition: null,
        normalizedCondition: "graded",
        trendAnchorPoints: [],
        grade: graded.gradeBucket,
        gradedProvider: graded.provider,
        gradedBucket: graded.gradeBucket,
        isPerfect: graded.isPerfect,
        lowPrice: graded.low,
        highPrice: graded.high,
      });
    }
    return results;
  }

  for (const variant of variants) {
    const variantName = String((variant as ScrydexVariant).name ?? "unknown").trim() || "unknown";
    const variantId = variantName.replace(/\s+/g, "_").toLowerCase();
    const variantPrices = (variant as ScrydexVariant).prices;
    const pricingSelection = selectPreferredScrydexPriceEntry(variantPrices, { preferLow });

    if (pricingSelection) {
      const semantics = parseScrydexVariantSemantics(variantName);
      results.push({
        variantName,
        variantId,
        observedPrice: pricingSelection.price,
        currency: pricingSelection.currency,
        askingPriceUsd: extractAskingPriceUsd(pricingSelection),
        providerFinish: semantics.providerFinish,
        normalizedFinish: semantics.normalizedFinish,
        normalizedEdition: semantics.normalizedEdition,
        normalizedStamp: semantics.normalizedStamp,
        stampLabel: semantics.stampLabel,
        hasSpecialVariantToken: semantics.hasSpecialVariantToken,
        specialVariantToken: semantics.specialVariantToken,
        providerCondition: pricingSelection.providerCondition,
        normalizedCondition: pricingSelection.normalizedCondition,
        trendAnchorPoints: extractTrendAnchorPoints(variantPrices),
        ...RAW_DEFAULTS,
      });
    }

    // Extract graded entries for this variant
    for (const graded of selectScrydexGradedEntries(variantPrices)) {
      const semantics = parseScrydexVariantSemantics(variantName);
      results.push({
        variantName,
        variantId,
        observedPrice: graded.price,
        currency: graded.currency,
        // See note above: graded paths intentionally don't carry an
        // asking-anchored auxiliary value (their headline is already
        // scrydex's `market`).
        askingPriceUsd: null,
        providerFinish: semantics.providerFinish,
        normalizedFinish: semantics.normalizedFinish,
        normalizedEdition: semantics.normalizedEdition,
        normalizedStamp: semantics.normalizedStamp,
        stampLabel: semantics.stampLabel,
        hasSpecialVariantToken: semantics.hasSpecialVariantToken,
        specialVariantToken: semantics.specialVariantToken,
        providerCondition: null,
        normalizedCondition: "graded",
        trendAnchorPoints: [],
        grade: graded.gradeBucket,
        gradedProvider: graded.provider,
        gradedBucket: graded.gradeBucket,
        isPerfect: graded.isPerfect,
        lowPrice: graded.low,
        highPrice: graded.high,
      });
    }
  }

  return results;
}

function buildObservationRow(params: {
  rawPayload: RawPayloadRow;
  providerRawPayloadLineageId: string;
  providerSetId: string | null;
  card: ScrydexCard;
  variant: VariantObservation;
  normalizedAt: string;
}): NormalizedObservationRow | null {
  const { rawPayload, providerRawPayloadLineageId, providerSetId, card, variant, normalizedAt } = params;
  const providerCardId = String(card.id ?? "").trim();
  if (!providerCardId) return null;

  const isGraded = variant.grade !== "RAW" && variant.gradedProvider && variant.gradedBucket;
  const providerVariantId = isGraded
    ? `${providerCardId}:${variant.variantId}::GRADED::${variant.gradedProvider}::${variant.gradedBucket}`
    : `${providerCardId}:${variant.variantId}`;
  const cardNumberRaw = String(card.number ?? card.printed_number ?? "").trim() || null;
  const normalizedCardNumber = normalizeCardNumber(cardNumberRaw);
  const observedAtMs = Date.parse(rawPayload.fetched_at);
  const providerTrendAnchorPoints = Number.isFinite(observedAtMs)
    ? variant.trendAnchorPoints
      .map((point) => ({
        ts: new Date(observedAtMs - (point.lookbackDays * 24 * 60 * 60 * 1000)).toISOString(),
        price: point.price,
        currency: point.currency,
        sourceWindow: point.sourceWindow,
      }))
      .filter((point) => point.price > 0 && point.ts < rawPayload.fetched_at)
    : [];
  // historyPoints30d is empty while extractTrendAnchorPoints stays
  // disabled (see its docs for why). When a future PR adds a metrics
  // consumer that can correctly handle market-basis anchors, populate
  // this array from the basis-tagged trend anchor points.
  const historyPoints30d: Array<{ ts: string; price: number; currency: "USD" | "EUR" | "JPY" }> =
    providerTrendAnchorPoints
      .filter((point) => point.sourceWindow === "market_anchor_30d")
      .map((point) => ({
        ts: point.ts,
        price: point.price,
        currency: point.currency,
      }));

  return {
    provider_raw_payload_id: rawPayload.id,
    provider_raw_payload_lineage_id: providerRawPayloadLineageId,
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
    normalized_stamp: variant.normalizedStamp,
    provider_condition: variant.providerCondition,
    normalized_condition: variant.normalizedCondition,
    provider_language: card.language_code ?? "en",
    normalized_language: normalizeProviderLanguageToCanonical(card.language_code),
    variant_ref: buildLegacyVariantRef(
      variant.variantName,
      variant.normalizedEdition,
      variant.stampLabel,
      variant.providerCondition ?? (isGraded ? "graded" : "Near Mint"),
      variantRefLanguageLabel(normalizeProviderLanguageToCanonical(card.language_code)),
      isGraded ? `${variant.gradedProvider}_${variant.gradedBucket}` : "RAW",
    ),
    observed_price: variant.observedPrice,
    currency: variant.currency,
    observed_at: rawPayload.fetched_at,
    history_points_30d: historyPoints30d,
    history_points_30d_count: historyPoints30d.length,
    metadata: {
      rawFetchedAt: rawPayload.fetched_at,
      requestHash: rawPayload.request_hash ?? null,
      responseHash: rawPayload.response_hash ?? null,
      providerCardId: card.id ?? null,
      providerRarity: card.rarity ?? null,
      providerExpansion: card.expansion ?? null,
      providerVariant: variant.variantName,
      normalizedStamp: variant.normalizedStamp,
      hasSpecialVariantToken: variant.hasSpecialVariantToken,
      specialVariantToken: variant.specialVariantToken,
      providerCondition: variant.providerCondition,
      normalizedCondition: variant.normalizedCondition,
      providerVariantPricingCurrency: variant.currency,
      providerTrendAnchorPoints,
      // Graded metadata — downstream timeseries + variant-metrics readers
      // use these to set price_snapshots.grade and variant_metrics.grade.
      grade: variant.grade,
      gradedCompany: variant.gradedProvider,
      gradedBucket: variant.gradedBucket,
      isPerfect: variant.isPerfect,
      lowPrice: variant.lowPrice,
      highPrice: variant.highPrice,
      // Phase C-2 (2026-05-16): scrydex `market` (USD) preserved
      // separately so the card detail page can render "Asking: $X"
      // alongside the headline. Read by app/c/[slug]/page.tsx via the
      // latest scrydex observation. Null on graded observations. NOTE
      // (2026-06-25): for EN-RAW the headline now ALSO tracks `market`
      // (observed_price), so this equals the headline for EN; it still
      // diverges for JP-RAW, whose headline tracks `low`.
      scrydexAskingPriceUsd: variant.askingPriceUsd,
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
      const providerRawPayloadLineageId = await ensureProviderRawPayloadLineageId(supabase, rawPayload.id);
      const rows: NormalizedObservationRow[] = [];

      for (const card of cards) {
        const variants = buildVariantObservations(card);
        for (const variant of variants) {
          const observation = buildObservationRow({
            rawPayload,
            providerRawPayloadLineageId,
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
        // Postgres upsert cannot update the same target row twice in one statement.
        // Deduplicate by the exact conflict key to keep the newest observation per key.
        const dedupedRowsByKey = new Map<string, NormalizedObservationRow>();
        for (const row of rows) {
          const key = `${row.provider_raw_payload_lineage_id}::${row.provider_card_id}::${row.provider_variant_id}`;
          dedupedRowsByKey.set(key, row);
        }
        const dedupedRows = [...dedupedRowsByKey.values()];
        const duplicateAffectError = "ON CONFLICT DO UPDATE command cannot affect row a second time";
        const batchResult = await retrySupabaseWriteOperation(
          "provider_normalized_observations(upsert batch)",
          async () => {
            const { data, error } = await supabase
              .from("provider_normalized_observations")
              .upsert(dedupedRows, {
                onConflict: "provider_raw_payload_lineage_id,provider_card_id,provider_variant_id",
              })
              .select("id");

            if (error) {
              const message = String(error.message ?? "");
              if (!message.includes(duplicateAffectError)) throw new Error(message);
              return { duplicateConflict: true, data: [] as Array<{ id: string }> };
            }

            return { duplicateConflict: false, data: (data ?? []) as Array<{ id: string }> };
          },
        );

        if (batchResult.duplicateConflict) {
          // Defensive fallback for unexpected duplicate-key batches:
          // retry row-by-row so one bad row does not fail the whole payload.
          let fallbackCount = 0;
          for (const row of dedupedRows) {
            const singleData = await retrySupabaseWriteOperation(
              "provider_normalized_observations(upsert row)",
              async () => {
                const { data: singleData, error: singleError } = await supabase
                  .from("provider_normalized_observations")
                  .upsert(row, {
                    onConflict: "provider_raw_payload_lineage_id,provider_card_id,provider_variant_id",
                  })
                  .select("id");
                if (singleError) throw new Error(singleError.message);
                return (singleData ?? []) as Array<{ id: string }>;
              },
            );
            fallbackCount += singleData.length;
          }
          insertedOrUpdated = fallbackCount;
          observationsUpserted += insertedOrUpdated;
        } else {
          insertedOrUpdated = batchResult.data.length;
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

export async function runScrydexRawNormalize(opts: {
  payloadLimit?: number;
  providerSetId?: string | null;
  rawPayloadId?: string | null;
  force?: boolean;
} = {}): Promise<RawNormalizeResult> {
  return runPokemonTcgRawNormalize(opts);
}
