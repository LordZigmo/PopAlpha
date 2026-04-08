import { dbAdmin } from "@/lib/db/admin";
import { refreshPipelineRollupsForVariantKeys } from "@/lib/backfill/provider-pipeline-rollups";
import {
  loadCoverageGapSetPriority,
  loadHighValueStaleSetPriority,
  loadRecentSetConsistencyPriority,
} from "@/lib/backfill/set-priority";
import {
  isRetryableSupabaseWriteErrorMessage,
  retrySupabaseWriteOperation,
} from "@/lib/backfill/supabase-write-retry";
import { normalizeScrydexVariantToken } from "@/lib/backfill/scrydex-variant-semantics";
import { buildProviderHistoryVariantRef } from "@/lib/identity/variant-ref.mjs";
import { normalizeCondition } from "@/lib/providers/justtcg";
import {
  fetchCardPriceHistoryPage,
  getScrydexCredentials,
  type ScrydexPriceHistoryDay,
  type ScrydexPriceHistoryEntry,
} from "@/lib/scrydex/client";

const PROVIDER = "SCRYDEX";
const SCRYDEX_HISTORY_CREDITS_PER_CARD = 3;
const DEFAULT_HISTORY_DAYS = 90;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_HOT_SET_LIMIT = process.env.SCRYDEX_HISTORY_HOT_SET_LIMIT
  ? Math.max(1, parseInt(process.env.SCRYDEX_HISTORY_HOT_SET_LIMIT, 10))
  : 24;
const DEFAULT_HISTORY_MAX_CREDITS = process.env.SCRYDEX_HISTORY_MAX_CREDITS
  ? Math.max(1, parseInt(process.env.SCRYDEX_HISTORY_MAX_CREDITS, 10))
  : 10000;
const DEFAULT_HISTORY_MAX_CARDS_PER_RUN = process.env.SCRYDEX_HISTORY_MAX_CARDS_PER_RUN
  ? Math.max(1, parseInt(process.env.SCRYDEX_HISTORY_MAX_CARDS_PER_RUN, 10))
  : 1000;
const DEFAULT_HISTORY_WRITE_RETRY_ATTEMPTS = process.env.SCRYDEX_HISTORY_WRITE_RETRY_ATTEMPTS
  ? Math.max(1, parseInt(process.env.SCRYDEX_HISTORY_WRITE_RETRY_ATTEMPTS, 10))
  : 5;
const DEFAULT_HISTORY_WRITE_RETRY_BACKOFF_MS = process.env.SCRYDEX_HISTORY_WRITE_RETRY_BACKOFF_MS
  ? Math.max(0, parseInt(process.env.SCRYDEX_HISTORY_WRITE_RETRY_BACKOFF_MS, 10))
  : 400;
const DEFAULT_DAILY_REQUEST_BUDGET_FALLBACK = process.env.SCRYDEX_DAILY_REQUEST_BUDGET_FALLBACK
  ? Math.max(1, parseInt(process.env.SCRYDEX_DAILY_REQUEST_BUDGET_FALLBACK, 10))
  : 120;
const DEFAULT_DAILY_REQUEST_BUDGET_HEADROOM = process.env.SCRYDEX_DAILY_REQUEST_BUDGET_HEADROOM
  ? Math.max(1, parseFloat(process.env.SCRYDEX_DAILY_REQUEST_BUDGET_HEADROOM))
  : 1.15;
const DEFAULT_DAILY_REQUEST_BUDGET_MIN_SWEEP_PCT = process.env.SCRYDEX_DAILY_REQUEST_BUDGET_MIN_SWEEP_PCT
  ? Math.min(1, Math.max(0, parseFloat(process.env.SCRYDEX_DAILY_REQUEST_BUDGET_MIN_SWEEP_PCT)))
  : 1.0;
const DEFAULT_DAILY_REQUEST_BUDGET_LOOKBACK_HOURS = process.env.SCRYDEX_DAILY_REQUEST_BUDGET_LOOKBACK_HOURS
  ? Math.max(1, parseInt(process.env.SCRYDEX_DAILY_REQUEST_BUDGET_LOOKBACK_HOURS, 10))
  : 24;
const WRITE_CHUNK_SIZE = 500;
// Supabase REST GET queries for variant_ref IN-lists become unstable around 200 refs for large sets.
const QUERY_CHUNK_SIZE = 100;
const PINNED_HOT_SET_IDS = (() => {
  const defaults = ["sv3pt5"];
  const configured = String(process.env.SCRYDEX_PINNED_HOT_SET_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...defaults, ...configured])];
})();

type SetPriorityTarget = {
  setCode: string | null;
  setName: string | null;
  providerSetId: string;
};

type ProviderCardMapSummaryRow = {
  provider_set_id: string | null;
  provider_card_id: string | null;
  mapping_status: string | null;
  canonical_slug: string | null;
  printing_id: string | null;
  provider_variant_id: string | null;
};

type ProviderSetMapRow = {
  canonical_set_code: string | null;
  canonical_set_name: string | null;
  provider_set_id: string | null;
};

type ProviderSetHealthRow = {
  provider_set_id: string | null;
  last_success_at: string | null;
  requests_last_run: number | null;
  cards_last_run: number | null;
};

type PriceHistoryStateRow = {
  variant_ref: string | null;
  ts: string | null;
};

type ScrydexVariantMapping = {
  providerCardId: string;
  providerVariantId: string;
  providerVariantToken: string;
  canonicalSlug: string;
  printingId: string | null;
  historyVariantRef: string;
};

type ScrydexCardHistoryTarget = {
  providerSetId: string;
  providerCardId: string;
  variants: ScrydexVariantMapping[];
};

type ScrydexSetFootprint = {
  providerSetId: string;
  setCode: string | null;
  setName: string | null;
  expectedCardCount: number;
  providerCardCount: number;
  matchedCardCount: number;
  dailyCaptureRequests: number;
  historyBackfillRequests: number;
  historyBackfillCredits: number;
  priorityReasons: string[];
};

type ExistingSnapshotHistoryState = {
  dayKeys: Set<string>;
  variantRefs: Set<string>;
};

export type ScrydexRecentHistoryCoverageAudit = ScrydexSetFootprint & {
  recentHistoryDays: number;
  cardsWithRecentSnapshot: number;
  cardsMissingRecentSnapshot: number;
  cardsMissingMappings: number;
  needsHistoryCatchup: boolean;
};

export type ScrydexRecentHistoryCatchupPlanRow = ScrydexRecentHistoryCoverageAudit & {
  plannedCardCount: number;
  plannedCredits: number;
};

export type ScrydexRecentHistoryCatchupPlan = {
  ok: true;
  generatedAt: string;
  days: number;
  maxCredits: number;
  selectedSets: ScrydexRecentHistoryCatchupPlanRow[];
  skippedSets: ScrydexRecentHistoryCatchupPlanRow[];
  estimatedCredits: number;
  plannedCards: number;
};

type HistoryWriteRow = {
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  ts: string;
  price: number;
  currency: string;
  source_window: "snapshot";
};

type HistoryBackfillSample = {
  providerSetId: string;
  providerCardId: string;
  providerVariantId: string;
  canonicalSlug: string;
  ts: string;
  price: number;
  currency: string;
};

type SelectedRawHistoryPrice = {
  price: number;
  currency: string;
  condition: string;
};

export type ResolvedScrydexHistoryDay = {
  dayKey: string;
  selected: SelectedRawHistoryPrice;
  source: "provider" | "carry_forward";
};

export type ResolvedScrydexHistoryDaySet = {
  days: ResolvedScrydexHistoryDay[];
  providerDaysMissingRaw: number;
};

export type ScrydexHistoryBackfillPlan = {
  ok: true;
  generatedAt: string;
  maxCredits: number;
  hotSetLimit: number;
  selectedSets: ScrydexSetFootprint[];
  skippedSets: ScrydexSetFootprint[];
  estimatedCredits: number;
};

export type ScrydexDailyCapturePlanRow = ScrydexSetFootprint & {
  priorityWeight: number;
};

export type ScrydexDailyCapturePlanChunk = {
  chunkNumber: number;
  plannedRequests: number;
  plannedExpectedCardCount: number;
  plannedMatchedCardCount: number;
  providerSetIds: string[];
  selectedSets: ScrydexDailyCapturePlanRow[];
};

export type ScrydexDailyCapturePlan = {
  ok: true;
  generatedAt: string;
  chunkCount: number;
  totalAvailableRequests: number;
  maxRequests: number;
  recentSuccessfulRequests: number;
  selectedSets: ScrydexDailyCapturePlanRow[];
  skippedSets: ScrydexDailyCapturePlanRow[];
  chunks: ScrydexDailyCapturePlanChunk[];
};

export type ScrydexHistoryBackfillResult = {
  ok: boolean;
  provider: "SCRYDEX";
  providerSetId: string;
  days: number;
  dryRun: boolean;
  startedAt: string;
  endedAt: string;
  cardsPlanned: number;
  cardsFetched: number;
  cardsSkippedBudget: number;
  cardsSkippedAlreadyCovered: number;
  cardsSkippedNoHistory: number;
  estimatedCreditsPlanned: number;
  estimatedCreditsUsed: number;
  historyRowsPrepared: number;
  historyRowsUpserted: number;
  historyRowsSkippedExistingDay: number;
  historyRowsSkippedNoNearMint: number;
  historyRowsForwardFilled: number;
  distinctSnapshotDaysWritten: number;
  sampleWrites: HistoryBackfillSample[];
  touchedVariantKeys: Array<{
    canonical_slug: string;
    variant_ref: string;
    provider: string;
    grade: string;
  }>;
  firstError: string | null;
};

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeStringList(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    output.push(values.slice(index, index + chunkSize));
  }
  return output;
}

function extractDayKey(value: string | null | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";

  const prefixedDate = normalized.slice(0, 10).replace(/\//g, "-");
  if (/^\d{4}-\d{2}-\d{2}$/.test(prefixedDate)) {
    return prefixedDate;
  }

  const match = normalized.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (!match) return prefixedDate;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function calculateScrydexDailyCaptureRequests(cardCount: number): number {
  if (!Number.isFinite(cardCount) || cardCount <= 0) return 1;
  return Math.max(1, Math.ceil(cardCount / 100));
}

export function calculateScrydexHistoryBackfillCredits(cardCount: number): number {
  if (!Number.isFinite(cardCount) || cardCount <= 0) return 0;
  return Math.max(0, Math.floor(cardCount)) * SCRYDEX_HISTORY_CREDITS_PER_CARD;
}

export function summarizeScrydexRecentHistoryCoverage(input: {
  expectedCardCount: number;
  matchedCardCount: number;
  cardsWithRecentSnapshot: number;
  recentHistoryDays: number;
}) {
  const expectedCardCount = Math.max(0, Math.floor(input.expectedCardCount));
  const matchedCardCount = Math.max(0, Math.floor(input.matchedCardCount));
  const cardsWithRecentSnapshot = Math.min(
    matchedCardCount,
    Math.max(0, Math.floor(input.cardsWithRecentSnapshot)),
  );
  const cardsMissingRecentSnapshot = Math.max(0, matchedCardCount - cardsWithRecentSnapshot);
  const cardsMissingMappings = Math.max(0, expectedCardCount - matchedCardCount);

  return {
    recentHistoryDays: Math.max(1, Math.floor(input.recentHistoryDays)),
    cardsWithRecentSnapshot,
    cardsMissingRecentSnapshot,
    cardsMissingMappings,
    needsHistoryCatchup: cardsMissingRecentSnapshot > 0,
  };
}
export const isRetryableHistoryWriteErrorMessage = isRetryableSupabaseWriteErrorMessage;
export const retryHistoryWriteOperation = retrySupabaseWriteOperation;

export function isMissingScrydexCardHistoryErrorMessage(message: string): boolean {
  const normalized = normalizeText(message).toLowerCase();
  return normalized.includes("scrydex api error 404");
}

export function historyDateToSnapshotTs(date: string): string {
  const normalized = extractDayKey(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`Invalid history date: ${date}`);
  }
  return `${normalized}T12:00:00.000Z`;
}

function buildTrailingUtcDayKeys(windowDays: number, asOfInput: Date | string | number = new Date()): string[] {
  const safeWindowDays = Math.max(1, Math.floor(windowDays));
  const parsedAsOf = new Date(asOfInput);
  const asOf = Number.isNaN(parsedAsOf.getTime()) ? new Date() : parsedAsOf;
  const asOfDayMs = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const dayKeys: string[] = [];
  for (let offset = safeWindowDays - 1; offset >= 0; offset -= 1) {
    dayKeys.push(new Date(asOfDayMs - (offset * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10));
  }
  return dayKeys;
}

export function resolveScrydexRawHistoryDays(params: {
  historyDays: ScrydexPriceHistoryDay[] | null | undefined;
  providerVariantToken: string;
  windowDays: number;
  asOf?: Date | string | number;
}): ResolvedScrydexHistoryDaySet {
  const actualDayKeys = new Set<string>();
  const pricesByDayKey = new Map<string, ScrydexPriceHistoryEntry[]>();

  for (const historyDay of params.historyDays ?? []) {
    const dayKey = extractDayKey(historyDay?.date);
    if (!dayKey) continue;
    actualDayKeys.add(dayKey);
    const bucket = pricesByDayKey.get(dayKey) ?? [];
    if (Array.isArray(historyDay?.prices)) bucket.push(...historyDay.prices);
    pricesByDayKey.set(dayKey, bucket);
  }

  const windowDayKeys = buildTrailingUtcDayKeys(params.windowDays, params.asOf);
  const windowDayKeySet = new Set(windowDayKeys);
  const orderedDayKeys = [...new Set([...actualDayKeys, ...windowDayKeys])].sort();
  const resolvedDays: ResolvedScrydexHistoryDay[] = [];
  let carryForward: SelectedRawHistoryPrice | null = null;
  let providerDaysMissingRaw = 0;

  for (const dayKey of orderedDayKeys) {
    const directSelected = actualDayKeys.has(dayKey)
      ? selectScrydexRawHistoryPrice(pricesByDayKey.get(dayKey) ?? [], params.providerVariantToken)
      : null;

    if (directSelected) {
      carryForward = directSelected;
      resolvedDays.push({
        dayKey,
        selected: directSelected,
        source: "provider",
      });
      continue;
    }

    if (actualDayKeys.has(dayKey)) {
      providerDaysMissingRaw += 1;
    }

    if (!windowDayKeySet.has(dayKey) || carryForward === null) continue;

    resolvedDays.push({
      dayKey,
      selected: carryForward,
      source: "carry_forward",
    });
  }

  return {
    days: resolvedDays,
    providerDaysMissingRaw,
  };
}

export function providerVariantIdToScrydexToken(providerVariantId: string): string {
  const normalized = normalizeText(providerVariantId);
  const rawVariant = normalized.includes(":")
    ? normalized.split(":").at(-1) ?? normalized
    : normalized;
  return normalizeScrydexVariantToken(rawVariant);
}

function getPositivePrice(entry: ScrydexPriceHistoryEntry): number | null {
  const candidates = [entry.market, entry.low, entry.mid, entry.high];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

export function selectScrydexRawHistoryPrice(
  prices: ScrydexPriceHistoryEntry[] | null | undefined,
  providerVariantToken: string,
): SelectedRawHistoryPrice | null {
  const normalizedVariantToken = normalizeScrydexVariantToken(providerVariantToken);
  if (!normalizedVariantToken || !Array.isArray(prices) || prices.length === 0) return null;

  let best: { score: number; selected: SelectedRawHistoryPrice } | null = null;

  for (const row of prices) {
    if (!row || typeof row !== "object") continue;
    if (String(row.type ?? "").trim().toLowerCase() !== "raw") continue;
    if (row.is_error === true || row.is_signed === true || row.is_perfect === true) continue;

    const variantToken = normalizeScrydexVariantToken(row.variant);
    if (variantToken !== normalizedVariantToken) continue;

    const normalizedCondition = normalizeCondition(String(row.condition ?? ""));
    if (normalizedCondition !== "nm" && normalizedCondition !== "mint") continue;

    const price = getPositivePrice(row);
    if (price === null) continue;

    let score = 0;
    if (normalizedCondition === "nm") score += 100;
    if (normalizedCondition === "mint") score += 90;
    if (typeof row.market === "number" && Number.isFinite(row.market) && row.market > 0) score += 20;
    if (typeof row.low === "number" && Number.isFinite(row.low) && row.low > 0) score += 10;

    const selected: SelectedRawHistoryPrice = {
      price,
      currency: normalizeText(row.currency) || "USD",
      condition: normalizedCondition,
    };
    if (!best || score > best.score) {
      best = { score, selected };
    }
  }

  return best?.selected ?? null;
}

async function fetchAllProviderCardMapRows(
  select: string,
  providerSetIds?: string[],
): Promise<ProviderCardMapSummaryRow[]> {
  const supabase = dbAdmin();
  const normalizedProviderSetIds = normalizeStringList(providerSetIds ?? []);
  const rows: ProviderCardMapSummaryRow[] = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase
      .from("provider_card_map")
      .select(select)
      .eq("provider", PROVIDER)
      .order("provider_set_id", { ascending: true })
      .order("provider_card_id", { ascending: true });
    if (normalizedProviderSetIds.length > 0) {
      query = query.in("provider_set_id", normalizedProviderSetIds);
    }
    const { data, error } = await query
      .range(from, from + 999)
      .returns<ProviderCardMapSummaryRow[]>();
    if (error) throw new Error(`provider_card_map(load): ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function loadScrydexCanonicalSetCardCounts(setNames: string[]): Promise<Map<string, number>> {
  const normalizedNames = normalizeStringList(setNames);
  if (normalizedNames.length === 0) return new Map();

  const supabase = dbAdmin();
  const counts = new Map<string, number>();
  for (const chunk of chunkValues(normalizedNames, QUERY_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("canonical_set_catalog")
      .select("set_name, card_count")
      .in("set_name", chunk)
      .returns<Array<{ set_name: string | null; card_count: number | null }>>();
    if (error) throw new Error(`canonical_set_catalog(load set counts): ${error.message}`);
    for (const row of data ?? []) {
      const setName = normalizeText(row.set_name);
      if (!setName) continue;
      counts.set(setName, Math.max(0, Math.floor(row.card_count ?? 0)));
    }
  }
  return counts;
}

function buildScrydexCardHistoryTargets(rows: ProviderCardMapSummaryRow[]): ScrydexCardHistoryTarget[] {
  const byCardId = new Map<string, ScrydexCardHistoryTarget>();
  for (const row of rows) {
    const providerSetId = normalizeText(row.provider_set_id);
    const providerCardId = normalizeText(row.provider_card_id);
    const providerVariantId = normalizeText(row.provider_variant_id);
    const canonicalSlug = normalizeText(row.canonical_slug);
    if (!providerSetId || !providerCardId || !providerVariantId || !canonicalSlug) continue;

    const target = byCardId.get(providerCardId) ?? {
      providerSetId,
      providerCardId,
      variants: [],
    };
    target.variants.push({
      providerCardId,
      providerVariantId,
      providerVariantToken: providerVariantIdToScrydexToken(providerVariantId),
      canonicalSlug,
      printingId: normalizeText(row.printing_id) || null,
      historyVariantRef: buildProviderHistoryVariantRef({
        printingId: normalizeText(row.printing_id) || null,
        canonicalSlug,
        provider: PROVIDER,
        providerVariantId,
      }),
    });
    byCardId.set(providerCardId, target);
  }

  return [...byCardId.values()].sort((left, right) => left.providerCardId.localeCompare(right.providerCardId));
}

async function loadMatchedProviderCardMapRows(providerSetIds?: string[]): Promise<ProviderCardMapSummaryRow[]> {
  const supabase = dbAdmin();
  const normalizedProviderSetIds = normalizeStringList(providerSetIds ?? []);
  const rows: ProviderCardMapSummaryRow[] = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase
      .from("provider_card_map")
      .select("provider_set_id, provider_card_id, provider_variant_id, canonical_slug, printing_id, mapping_status")
      .eq("provider", PROVIDER)
      .eq("mapping_status", "MATCHED")
      .order("provider_set_id", { ascending: true })
      .order("provider_card_id", { ascending: true })
      .order("provider_variant_id", { ascending: true });

    if (normalizedProviderSetIds.length > 0) {
      query = query.in("provider_set_id", normalizedProviderSetIds);
    }

    const { data, error } = await query
      .range(from, from + 999)
      .returns<ProviderCardMapSummaryRow[]>();
    if (error) throw new Error(`provider_card_map(load matched targets): ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function loadExistingSnapshotHistoryState(
  variantRefs: string[],
  sinceIso: string,
): Promise<ExistingSnapshotHistoryState> {
  const supabase = dbAdmin();
  const dayKeys = new Set<string>();
  const seenVariantRefs = new Set<string>();

  for (const chunk of chunkValues(variantRefs, QUERY_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("price_history_points")
      .select("variant_ref, ts")
      .eq("provider", PROVIDER)
      .eq("source_window", "snapshot")
      .in("variant_ref", chunk)
      .gte("ts", sinceIso)
      .returns<PriceHistoryStateRow[]>();
    if (error) throw new Error(`price_history_points(load existing history days): ${error.message}`);
    for (const row of data ?? []) {
      const variantRef = normalizeText(row.variant_ref);
      const dayKey = extractDayKey(row.ts);
      if (!variantRef || !dayKey) continue;
      seenVariantRefs.add(variantRef);
      dayKeys.add(`${variantRef}::${dayKey}`);
    }
  }

  return {
    dayKeys,
    variantRefs: seenVariantRefs,
  };
}

export async function loadScrydexSetFootprints(opts: {
  providerSetIds?: string[];
} = {}): Promise<ScrydexSetFootprint[]> {
  const supabase = dbAdmin();
  const normalizedProviderSetIds = normalizeStringList(opts.providerSetIds ?? []);
  const [providerCardMapRows, providerSetMapRows] = await Promise.all([
    fetchAllProviderCardMapRows("provider_set_id, provider_card_id, mapping_status", normalizedProviderSetIds),
    (async () => {
      const rows: ProviderSetMapRow[] = [];
      for (let from = 0; ; from += 1000) {
        let query = supabase
          .from("provider_set_map")
          .select("canonical_set_code, canonical_set_name, provider_set_id")
          .eq("provider", PROVIDER)
          .order("provider_set_id", { ascending: true });
        if (normalizedProviderSetIds.length > 0) {
          query = query.in("provider_set_id", normalizedProviderSetIds);
        }
        const { data, error } = await query
          .range(from, from + 999)
          .returns<ProviderSetMapRow[]>();
        if (error) throw new Error(`provider_set_map(load): ${error.message}`);
        const batch = data ?? [];
        rows.push(...batch);
        if (batch.length < 1000) break;
      }
      return rows;
    })(),
  ]);

  const footprintBySet = new Map<string, {
    providerCardIds: Set<string>;
    matchedCardIds: Set<string>;
  }>();

  for (const row of providerCardMapRows) {
    const providerSetId = normalizeText(row.provider_set_id);
    if (normalizedProviderSetIds.length > 0 && !normalizedProviderSetIds.includes(providerSetId)) continue;
    const providerCardId = normalizeText(row.provider_card_id);
    if (!providerSetId || !providerCardId) continue;
    const bucket = footprintBySet.get(providerSetId) ?? {
      providerCardIds: new Set<string>(),
      matchedCardIds: new Set<string>(),
    };
    bucket.providerCardIds.add(providerCardId);
    if (row.mapping_status === "MATCHED") bucket.matchedCardIds.add(providerCardId);
    footprintBySet.set(providerSetId, bucket);
  }

  const setMetaByProviderSet = new Map<string, ProviderSetMapRow>();
  for (const row of providerSetMapRows) {
    const providerSetId = normalizeText(row.provider_set_id);
    if (!providerSetId) continue;
    setMetaByProviderSet.set(providerSetId, row);
  }

  const setCardCountByName = await loadScrydexCanonicalSetCardCounts(
    [...setMetaByProviderSet.values()].map((row) => normalizeText(row.canonical_set_name)),
  );

  const footprints: ScrydexSetFootprint[] = [];
  const allProviderSetIds = normalizeStringList([
    ...footprintBySet.keys(),
    ...setMetaByProviderSet.keys(),
    ...normalizedProviderSetIds,
  ]);
  for (const providerSetId of allProviderSetIds) {
    const bucket = footprintBySet.get(providerSetId) ?? {
      providerCardIds: new Set<string>(),
      matchedCardIds: new Set<string>(),
    };
    const meta = setMetaByProviderSet.get(providerSetId) ?? null;
    const providerCardCount = bucket.providerCardIds.size;
    const matchedCardCount = bucket.matchedCardIds.size;
    const expectedCardCount = Math.max(
      setCardCountByName.get(normalizeText(meta?.canonical_set_name)) ?? 0,
      providerCardCount,
      matchedCardCount,
    );
    footprints.push({
      providerSetId,
      setCode: normalizeText(meta?.canonical_set_code) || providerSetId,
      setName: normalizeText(meta?.canonical_set_name) || providerSetId,
      expectedCardCount,
      providerCardCount,
      matchedCardCount,
      dailyCaptureRequests: calculateScrydexDailyCaptureRequests(expectedCardCount),
      historyBackfillRequests: matchedCardCount,
      historyBackfillCredits: calculateScrydexHistoryBackfillCredits(matchedCardCount),
      priorityReasons: [],
    });
  }

  footprints.sort((left, right) => left.providerSetId.localeCompare(right.providerSetId));
  return footprints;
}

function buildPriorityRankMap(providerSetIds: string[]): Map<string, number> {
  const normalized = normalizeStringList(providerSetIds);
  const size = normalized.length;
  return new Map(
    normalized.map((providerSetId, index) => [providerSetId, Math.max(1, size - index)] as const),
  );
}

function calculateDailyCapturePriorityDensity(row: ScrydexDailyCapturePlanRow): number {
  return row.dailyCaptureRequests > 0 ? row.priorityWeight / row.dailyCaptureRequests : row.priorityWeight;
}

function appendPriorityReason(
  row: ScrydexDailyCapturePlanRow,
  reason: string,
): ScrydexDailyCapturePlanRow {
  if (row.priorityReasons.includes(reason)) return row;
  return {
    ...row,
    priorityReasons: [...row.priorityReasons, reason],
  };
}

async function loadRecentSuccessfulScrydexRequests(opts: {
  providerSetIds?: string[];
  lookbackHours?: number;
} = {}): Promise<number> {
  const supabase = dbAdmin();
  const lookbackHours = Math.max(1, Math.floor(opts.lookbackHours ?? DEFAULT_DAILY_REQUEST_BUDGET_LOOKBACK_HOURS));
  const sinceIso = new Date(Date.now() - (lookbackHours * 60 * 60 * 1000)).toISOString();
  const providerSetIds = normalizeStringList(opts.providerSetIds ?? []);

  const loadRows = async (providerSetIdChunk?: string[]): Promise<ProviderSetHealthRow[]> => {
    const rows: ProviderSetHealthRow[] = [];
    for (let from = 0; ; from += 1000) {
      let query = supabase
        .from("provider_set_health")
        .select("provider_set_id, last_success_at, requests_last_run, cards_last_run")
        .eq("provider", PROVIDER)
        .gte("last_success_at", sinceIso)
        .gt("cards_last_run", 0)
        .order("provider_set_id", { ascending: true });
      if (providerSetIdChunk && providerSetIdChunk.length > 0) {
        query = query.in("provider_set_id", providerSetIdChunk);
      }
      const { data, error } = await query
        .range(from, from + 999)
        .returns<ProviderSetHealthRow[]>();
      if (error) throw new Error(`provider_set_health(load recent successful requests): ${error.message}`);
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < 1000) break;
    }
    return rows;
  };

  const rows = providerSetIds.length === 0
    ? await loadRows()
    : (await Promise.all(
      chunkValues(providerSetIds, 200).map((providerSetIdChunk) => loadRows(providerSetIdChunk)),
    )).flat();

  return rows.reduce((sum, row) => {
    const providerSetId = normalizeText(row.provider_set_id);
    if (!providerSetId || providerSetId === "__provider__") return sum;
    return sum + Math.max(0, Math.floor(row.requests_last_run ?? 0));
  }, 0);
}

export function resolveScrydexDailyRequestBudget(params: {
  totalAvailableRequests: number;
  recentSuccessfulRequests: number;
  maxRequests?: number;
  fallback?: number;
  headroom?: number;
  minSweepPct?: number;
}): number {
  const totalAvailableRequests = Math.max(0, Math.floor(params.totalAvailableRequests));
  if (totalAvailableRequests <= 0) return 0;

  if (typeof params.maxRequests === "number" && Number.isFinite(params.maxRequests)) {
    return Math.min(totalAvailableRequests, Math.max(0, Math.floor(params.maxRequests)));
  }

  const fallback = Math.max(1, Math.floor(params.fallback ?? DEFAULT_DAILY_REQUEST_BUDGET_FALLBACK));
  const headroom = Number.isFinite(params.headroom)
    ? Math.max(1, Number(params.headroom))
    : DEFAULT_DAILY_REQUEST_BUDGET_HEADROOM;
  const minSweepPct = Number.isFinite(params.minSweepPct)
    ? Math.min(1, Math.max(0, Number(params.minSweepPct)))
    : DEFAULT_DAILY_REQUEST_BUDGET_MIN_SWEEP_PCT;
  const learnedBudget = params.recentSuccessfulRequests > 0
    ? Math.max(1, Math.ceil(params.recentSuccessfulRequests * headroom))
    : fallback;
  const sweepFloor = Math.max(fallback, Math.ceil(totalAvailableRequests * minSweepPct));
  return Math.min(totalAvailableRequests, Math.max(learnedBudget, sweepFloor));
}

function buildScrydexDailyCapturePlanRows(params: {
  footprints: ScrydexSetFootprint[];
  recentConsistencySetIds: string[];
  highValuePrioritySetIds: string[];
  coveragePrioritySetIds: string[];
  explicitSetIds?: string[];
}): ScrydexDailyCapturePlanRow[] {
  const pinnedSetIds = new Set(PINNED_HOT_SET_IDS);
  const explicitRankMap = buildPriorityRankMap(params.explicitSetIds ?? []);
  const recentRankMap = buildPriorityRankMap(params.recentConsistencySetIds);
  const highValueRankMap = buildPriorityRankMap(params.highValuePrioritySetIds);
  const coverageRankMap = buildPriorityRankMap(params.coveragePrioritySetIds);

  return params.footprints
    .filter((footprint) => footprint.matchedCardCount > 0 && footprint.dailyCaptureRequests > 0)
    .map((footprint) => {
      const cardsPerRequest = footprint.matchedCardCount / footprint.dailyCaptureRequests;
      const matchCoverage = footprint.expectedCardCount > 0
        ? footprint.matchedCardCount / footprint.expectedCardCount
        : 0;
      const priorityReasons: string[] = [];

      if (explicitRankMap.has(footprint.providerSetId)) priorityReasons.push("explicit");
      if (pinnedSetIds.has(footprint.providerSetId)) priorityReasons.push("pinned");
      if (recentRankMap.has(footprint.providerSetId)) priorityReasons.push("recent-consistency");
      if (highValueRankMap.has(footprint.providerSetId)) priorityReasons.push("high-value-stale");
      if (coverageRankMap.has(footprint.providerSetId)) priorityReasons.push("coverage-gap");
      if (cardsPerRequest >= 90) priorityReasons.push("high-yield");
      else if (cardsPerRequest >= 60) priorityReasons.push("efficient");
      if (priorityReasons.length === 0) priorityReasons.push("matched");

      let priorityWeight = 0;
      if (explicitRankMap.has(footprint.providerSetId)) {
        priorityWeight += (explicitRankMap.get(footprint.providerSetId) ?? 0) * 400000;
      }
      if (pinnedSetIds.has(footprint.providerSetId)) priorityWeight += 20000000;
      priorityWeight += (recentRankMap.get(footprint.providerSetId) ?? 0) * 200000;
      priorityWeight += (highValueRankMap.get(footprint.providerSetId) ?? 0) * 120000;
      priorityWeight += (coverageRankMap.get(footprint.providerSetId) ?? 0) * 60000;
      priorityWeight += Math.round(cardsPerRequest * 1000);
      priorityWeight += footprint.matchedCardCount * 100;
      priorityWeight += Math.round(matchCoverage * 1000);

      return {
        ...footprint,
        priorityReasons,
        priorityWeight,
      };
    })
    .sort((left, right) => {
      const densityDelta = calculateDailyCapturePriorityDensity(right) - calculateDailyCapturePriorityDensity(left);
      if (densityDelta !== 0) return densityDelta;
      if (right.priorityWeight !== left.priorityWeight) return right.priorityWeight - left.priorityWeight;
      const leftCardsPerRequest = left.matchedCardCount / left.dailyCaptureRequests;
      const rightCardsPerRequest = right.matchedCardCount / right.dailyCaptureRequests;
      if (rightCardsPerRequest !== leftCardsPerRequest) return rightCardsPerRequest - leftCardsPerRequest;
      if (right.matchedCardCount !== left.matchedCardCount) return right.matchedCardCount - left.matchedCardCount;
      if (left.dailyCaptureRequests !== right.dailyCaptureRequests) {
        return left.dailyCaptureRequests - right.dailyCaptureRequests;
      }
      return left.providerSetId.localeCompare(right.providerSetId);
    });
}

export function buildBalancedScrydexDailyCapturePlanChunks(params: {
  selectedSets: ScrydexDailyCapturePlanRow[];
  chunkCount: number;
}): ScrydexDailyCapturePlanChunk[] {
  const chunkCount = Math.max(1, Math.floor(params.chunkCount));
  const totalPlannedRequests = params.selectedSets.reduce((sum, row) => sum + row.dailyCaptureRequests, 0);
  const totalExpectedCards = params.selectedSets.reduce((sum, row) => sum + row.expectedCardCount, 0);
  const totalMatchedCards = params.selectedSets.reduce((sum, row) => sum + row.matchedCardCount, 0);
  const targetRequestsPerChunk = Math.max(1, totalPlannedRequests / chunkCount);
  const targetExpectedCardsPerChunk = Math.max(1, totalExpectedCards / chunkCount);
  const targetMatchedCardsPerChunk = Math.max(1, totalMatchedCards / chunkCount);
  const chunks = Array.from({ length: chunkCount }, (_, index) => ({
    chunkNumber: index + 1,
    plannedRequests: 0,
    plannedExpectedCardCount: 0,
    plannedMatchedCardCount: 0,
    providerSetIds: [] as string[],
    selectedSets: [] as ScrydexDailyCapturePlanRow[],
  }));

  const assignmentOrder = [...params.selectedSets].sort((left, right) => {
    if (right.expectedCardCount !== left.expectedCardCount) {
      return right.expectedCardCount - left.expectedCardCount;
    }
    if (right.matchedCardCount !== left.matchedCardCount) {
      return right.matchedCardCount - left.matchedCardCount;
    }
    if (right.dailyCaptureRequests !== left.dailyCaptureRequests) {
      return right.dailyCaptureRequests - left.dailyCaptureRequests;
    }
    const densityDelta = calculateDailyCapturePriorityDensity(right) - calculateDailyCapturePriorityDensity(left);
    if (densityDelta !== 0) return densityDelta;
    if (right.priorityWeight !== left.priorityWeight) return right.priorityWeight - left.priorityWeight;
    return left.providerSetId.localeCompare(right.providerSetId);
  });

  for (const row of assignmentOrder) {
    const targetChunk = chunks.reduce((best, candidate) => {
      const candidateProjectedPeakLoad = Math.max(
        (candidate.plannedExpectedCardCount + row.expectedCardCount) / targetExpectedCardsPerChunk,
        (candidate.plannedMatchedCardCount + row.matchedCardCount) / targetMatchedCardsPerChunk,
        (candidate.plannedRequests + row.dailyCaptureRequests) / targetRequestsPerChunk,
      );
      const bestProjectedPeakLoad = Math.max(
        (best.plannedExpectedCardCount + row.expectedCardCount) / targetExpectedCardsPerChunk,
        (best.plannedMatchedCardCount + row.matchedCardCount) / targetMatchedCardsPerChunk,
        (best.plannedRequests + row.dailyCaptureRequests) / targetRequestsPerChunk,
      );
      if (candidateProjectedPeakLoad !== bestProjectedPeakLoad) {
        return candidateProjectedPeakLoad < bestProjectedPeakLoad ? candidate : best;
      }

      const candidateProjectedWeightedLoad = (
        ((candidate.plannedExpectedCardCount + row.expectedCardCount) / targetExpectedCardsPerChunk) * 4
        + ((candidate.plannedMatchedCardCount + row.matchedCardCount) / targetMatchedCardsPerChunk) * 3
        + ((candidate.plannedRequests + row.dailyCaptureRequests) / targetRequestsPerChunk) * 2
      );
      const bestProjectedWeightedLoad = (
        ((best.plannedExpectedCardCount + row.expectedCardCount) / targetExpectedCardsPerChunk) * 4
        + ((best.plannedMatchedCardCount + row.matchedCardCount) / targetMatchedCardsPerChunk) * 3
        + ((best.plannedRequests + row.dailyCaptureRequests) / targetRequestsPerChunk) * 2
      );
      if (candidateProjectedWeightedLoad !== bestProjectedWeightedLoad) {
        return candidateProjectedWeightedLoad < bestProjectedWeightedLoad ? candidate : best;
      }

      if (candidate.plannedExpectedCardCount !== best.plannedExpectedCardCount) {
        return candidate.plannedExpectedCardCount < best.plannedExpectedCardCount ? candidate : best;
      }
      if (candidate.plannedRequests !== best.plannedRequests) {
        return candidate.plannedRequests < best.plannedRequests ? candidate : best;
      }
      if (candidate.selectedSets.length !== best.selectedSets.length) {
        return candidate.selectedSets.length < best.selectedSets.length ? candidate : best;
      }
      return candidate.chunkNumber < best.chunkNumber ? candidate : best;
    });
    targetChunk.selectedSets.push(row);
    targetChunk.plannedRequests += row.dailyCaptureRequests;
    targetChunk.plannedExpectedCardCount += row.expectedCardCount;
    targetChunk.plannedMatchedCardCount += row.matchedCardCount;
  }

  return chunks.map((chunk) => {
    const selectedSets = [...chunk.selectedSets].sort((left, right) => {
      const densityDelta = calculateDailyCapturePriorityDensity(right) - calculateDailyCapturePriorityDensity(left);
      if (densityDelta !== 0) return densityDelta;
      if (right.priorityWeight !== left.priorityWeight) return right.priorityWeight - left.priorityWeight;
      return left.providerSetId.localeCompare(right.providerSetId);
    });
    return {
      chunkNumber: chunk.chunkNumber,
      plannedRequests: chunk.plannedRequests,
      plannedExpectedCardCount: chunk.plannedExpectedCardCount,
      plannedMatchedCardCount: chunk.plannedMatchedCardCount,
      providerSetIds: selectedSets.map((row) => row.providerSetId),
      selectedSets,
    };
  });
}

export async function planScrydexDailyCapture(opts: {
  providerSetIds?: string[];
  chunkCount?: number;
  maxRequests?: number;
  lookbackHours?: number;
  requestBudgetHeadroom?: number;
  requestBudgetMinSweepPct?: number;
} = {}): Promise<ScrydexDailyCapturePlan> {
  const explicitSetIds = normalizeStringList(opts.providerSetIds ?? []);
  const chunkCount = Math.max(1, Math.floor(opts.chunkCount ?? 8));
  const lookbackHours = Math.max(1, Math.floor(opts.lookbackHours ?? DEFAULT_DAILY_REQUEST_BUDGET_LOOKBACK_HOURS));
  const footprints = await loadScrydexSetFootprints({ providerSetIds: explicitSetIds });
  const candidateFootprints = footprints.filter((footprint) => (
    footprint.matchedCardCount > 0 && footprint.dailyCaptureRequests > 0
  ));
  const totalAvailableRequests = candidateFootprints.reduce((sum, footprint) => (
    sum + Math.max(0, footprint.dailyCaptureRequests)
  ), 0);
  const recentSuccessfulRequests = await loadRecentSuccessfulScrydexRequests({
    providerSetIds: explicitSetIds,
    lookbackHours,
  });
  const maxRequests = resolveScrydexDailyRequestBudget({
    totalAvailableRequests,
    recentSuccessfulRequests,
    maxRequests: opts.maxRequests,
    headroom: opts.requestBudgetHeadroom,
    minSweepPct: opts.requestBudgetMinSweepPct,
  });

  let orderedRows: ScrydexDailyCapturePlanRow[];
  if (explicitSetIds.length > 0) {
    orderedRows = buildScrydexDailyCapturePlanRows({
      footprints: candidateFootprints,
      recentConsistencySetIds: [],
      highValuePrioritySetIds: [],
      coveragePrioritySetIds: [],
      explicitSetIds,
    });
  } else {
    const targets: SetPriorityTarget[] = candidateFootprints.map((footprint) => ({
        setCode: footprint.setCode,
        setName: footprint.setName,
        providerSetId: footprint.providerSetId,
      }));

    const [recentConsistencySetIds, highValuePrioritySetIds, coveragePrioritySetIds] = await Promise.all([
      loadRecentSetConsistencyPriority({
        provider: PROVIDER,
        targets,
        yearFrom: 2024,
        freshWindowHours: 24,
        maxProviderSetIds: 300,
      }),
      loadHighValueStaleSetPriority({
        provider: PROVIDER,
        targets,
        staleWindowHours: 24,
        maxProviderSetIds: 300,
      }),
      loadCoverageGapSetPriority({
        provider: PROVIDER,
        targets,
        maxProviderSetIds: 300,
      }),
    ]);

    orderedRows = buildScrydexDailyCapturePlanRows({
      footprints: candidateFootprints,
      recentConsistencySetIds,
      highValuePrioritySetIds,
      coveragePrioritySetIds,
    });
  }

  const selectedSets: ScrydexDailyCapturePlanRow[] = [];
  const skippedSets: ScrydexDailyCapturePlanRow[] = [];
  let plannedRequests = 0;
  for (const row of orderedRows) {
    const nextPlannedRequests = plannedRequests + row.dailyCaptureRequests;
    if (nextPlannedRequests <= maxRequests) {
      selectedSets.push(row);
      plannedRequests = nextPlannedRequests;
      continue;
    }
    skippedSets.push(appendPriorityReason(row, "over-budget"));
  }

  const chunks = buildBalancedScrydexDailyCapturePlanChunks({
    selectedSets,
    chunkCount,
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    chunkCount,
    totalAvailableRequests,
    maxRequests,
    recentSuccessfulRequests,
    selectedSets,
    skippedSets,
    chunks,
  };
}

export function buildScrydexRecentHistoryCatchupPlan(params: {
  audits: ScrydexRecentHistoryCoverageAudit[];
  maxCredits: number;
}): ScrydexRecentHistoryCatchupPlan {
  const maxCredits = Math.max(0, Math.floor(params.maxCredits));
  const maxCards = Math.floor(maxCredits / SCRYDEX_HISTORY_CREDITS_PER_CARD);
  const orderedAudits = [...params.audits].sort((left, right) => {
    if (right.cardsMissingRecentSnapshot !== left.cardsMissingRecentSnapshot) {
      return right.cardsMissingRecentSnapshot - left.cardsMissingRecentSnapshot;
    }
    if (right.cardsMissingMappings !== left.cardsMissingMappings) {
      return right.cardsMissingMappings - left.cardsMissingMappings;
    }
    if (right.expectedCardCount !== left.expectedCardCount) {
      return right.expectedCardCount - left.expectedCardCount;
    }
    return left.providerSetId.localeCompare(right.providerSetId);
  });

  const selectedSets: ScrydexRecentHistoryCatchupPlanRow[] = [];
  const skippedSets: ScrydexRecentHistoryCatchupPlanRow[] = [];
  let plannedCards = 0;

  for (const audit of orderedAudits) {
    const remainingCards = Math.max(0, maxCards - plannedCards);
    const plannedCardCount = Math.min(audit.cardsMissingRecentSnapshot, remainingCards);
    const plannedCredits = calculateScrydexHistoryBackfillCredits(plannedCardCount);
    const row: ScrydexRecentHistoryCatchupPlanRow = {
      ...audit,
      plannedCardCount,
      plannedCredits,
    };
    if (plannedCardCount > 0) {
      selectedSets.push(row);
      plannedCards += plannedCardCount;
      continue;
    }
    skippedSets.push(row);
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    days: orderedAudits[0]?.recentHistoryDays ?? DEFAULT_HISTORY_DAYS,
    maxCredits,
    selectedSets,
    skippedSets,
    estimatedCredits: calculateScrydexHistoryBackfillCredits(plannedCards),
    plannedCards,
  };
}

export async function loadScrydexRecentHistoryCoverageAudits(opts: {
  providerSetIds?: string[];
  days?: number;
} = {}): Promise<ScrydexRecentHistoryCoverageAudit[]> {
  const providerSetIds = normalizeStringList(opts.providerSetIds ?? []);
  const recentHistoryDays = Math.max(1, Math.floor(opts.days ?? DEFAULT_HISTORY_DAYS));
  const [footprints, matchedRows] = await Promise.all([
    loadScrydexSetFootprints({ providerSetIds }),
    loadMatchedProviderCardMapRows(providerSetIds),
  ]);
  const historyTargets = buildScrydexCardHistoryTargets(matchedRows);
  const historyTargetsBySet = new Map<string, ScrydexCardHistoryTarget[]>();
  for (const target of historyTargets) {
    const bucket = historyTargetsBySet.get(target.providerSetId) ?? [];
    bucket.push(target);
    historyTargetsBySet.set(target.providerSetId, bucket);
  }

  const variantRefs = normalizeStringList(
    historyTargets.flatMap((target) => target.variants.map((variant) => variant.historyVariantRef)),
  );
  const sinceIso = new Date(Date.now() - (recentHistoryDays * 24 * 60 * 60 * 1000)).toISOString();
  const existingState = variantRefs.length > 0
    ? await loadExistingSnapshotHistoryState(variantRefs, sinceIso)
    : { dayKeys: new Set<string>(), variantRefs: new Set<string>() };

  return footprints.map((footprint) => {
    const cardTargets = historyTargetsBySet.get(footprint.providerSetId) ?? [];
    const cardsWithRecentSnapshot = cardTargets.reduce((count, target) => {
      const covered = target.variants.every((variant) => existingState.variantRefs.has(variant.historyVariantRef));
      return covered ? count + 1 : count;
    }, 0);
    const coverage = summarizeScrydexRecentHistoryCoverage({
      expectedCardCount: footprint.expectedCardCount,
      matchedCardCount: footprint.matchedCardCount,
      cardsWithRecentSnapshot,
      recentHistoryDays,
    });
    return {
      ...footprint,
      ...coverage,
    };
  });
}

function buildHotProviderSetIds(params: {
  targets: SetPriorityTarget[];
  recentConsistencySetIds: string[];
  highValuePrioritySetIds: string[];
  coveragePrioritySetIds: string[];
}): string[] {
  const targetSet = new Set(params.targets.map((target) => target.providerSetId));
  const output: string[] = [];
  const seen = new Set<string>();
  const add = (providerSetId: string | null | undefined) => {
    const normalized = normalizeText(providerSetId);
    if (!normalized || seen.has(normalized) || !targetSet.has(normalized)) return;
    seen.add(normalized);
    output.push(normalized);
  };

  for (const providerSetId of PINNED_HOT_SET_IDS) add(providerSetId);
  for (const providerSetId of params.recentConsistencySetIds) add(providerSetId);
  for (const providerSetId of params.highValuePrioritySetIds) add(providerSetId);
  for (const providerSetId of params.coveragePrioritySetIds) add(providerSetId);
  return output;
}

export async function planScrydexHistoricalBackfillSets(opts: {
  providerSetIds?: string[];
  maxCredits?: number;
  hotSetLimit?: number;
} = {}): Promise<ScrydexHistoryBackfillPlan> {
  const footprints = await loadScrydexSetFootprints();
  const footprintBySet = new Map(footprints.map((footprint) => [footprint.providerSetId, footprint] as const));
  const explicitSetIds = normalizeStringList(opts.providerSetIds ?? []);
  const maxCredits = Math.max(1, Math.floor(opts.maxCredits ?? DEFAULT_HISTORY_MAX_CREDITS));
  const hotSetLimit = Math.max(1, Math.floor(opts.hotSetLimit ?? DEFAULT_HOT_SET_LIMIT));

  const selectedSets: ScrydexSetFootprint[] = [];
  const skippedSets: ScrydexSetFootprint[] = [];
  let estimatedCredits = 0;

  const pushIfBudgetAllows = (footprint: ScrydexSetFootprint, reasons: string[]) => {
    const nextCredits = estimatedCredits + footprint.historyBackfillCredits;
    const candidate = { ...footprint, priorityReasons: reasons };
    if (selectedSets.length >= hotSetLimit || nextCredits > maxCredits) {
      skippedSets.push(candidate);
      return;
    }
    selectedSets.push(candidate);
    estimatedCredits = nextCredits;
  };

  if (explicitSetIds.length > 0) {
    for (const providerSetId of explicitSetIds) {
      const footprint = footprintBySet.get(providerSetId);
      if (!footprint || footprint.matchedCardCount <= 0) continue;
      pushIfBudgetAllows(footprint, ["explicit"]);
    }
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      maxCredits,
      hotSetLimit,
      selectedSets,
      skippedSets,
      estimatedCredits,
    };
  }

  const targets: SetPriorityTarget[] = footprints
    .filter((footprint) => footprint.matchedCardCount > 0)
    .map((footprint) => ({
      setCode: footprint.setCode,
      setName: footprint.setName,
      providerSetId: footprint.providerSetId,
    }));

  const [recentConsistencySetIds, highValuePrioritySetIds, coveragePrioritySetIds] = await Promise.all([
    loadRecentSetConsistencyPriority({
      provider: PROVIDER,
      targets,
      yearFrom: 2024,
      freshWindowHours: 24,
      maxProviderSetIds: 300,
    }),
    loadHighValueStaleSetPriority({
      provider: PROVIDER,
      targets,
      staleWindowHours: 24,
      maxProviderSetIds: 300,
    }),
    loadCoverageGapSetPriority({
      provider: PROVIDER,
      targets,
      maxProviderSetIds: 300,
    }),
  ]);

  const hotProviderSetIds = buildHotProviderSetIds({
    targets,
    recentConsistencySetIds,
    highValuePrioritySetIds,
    coveragePrioritySetIds,
  });

  const reasonBySet = new Map<string, Set<string>>();
  const addReason = (providerSetId: string, reason: string) => {
    const bucket = reasonBySet.get(providerSetId) ?? new Set<string>();
    bucket.add(reason);
    reasonBySet.set(providerSetId, bucket);
  };
  for (const providerSetId of PINNED_HOT_SET_IDS) addReason(providerSetId, "pinned");
  for (const providerSetId of recentConsistencySetIds) addReason(providerSetId, "recent-consistency");
  for (const providerSetId of highValuePrioritySetIds) addReason(providerSetId, "high-value-stale");
  for (const providerSetId of coveragePrioritySetIds) addReason(providerSetId, "coverage-gap");

  const orderedSetIds = [
    ...hotProviderSetIds,
    ...footprints
      .filter((footprint) => footprint.matchedCardCount > 0 && !hotProviderSetIds.includes(footprint.providerSetId))
      .sort((left, right) => right.matchedCardCount - left.matchedCardCount || left.providerSetId.localeCompare(right.providerSetId))
      .map((footprint) => footprint.providerSetId),
  ];

  for (const providerSetId of orderedSetIds) {
    const footprint = footprintBySet.get(providerSetId);
    if (!footprint || footprint.matchedCardCount <= 0) continue;
    pushIfBudgetAllows(footprint, [...(reasonBySet.get(providerSetId) ?? ["matched"])]);
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    maxCredits,
    hotSetLimit,
    selectedSets,
    skippedSets,
    estimatedCredits,
  };
}

function mergeTouchedVariantKeys(
  keys: Array<{
    canonical_slug: string;
    variant_ref: string;
    provider: string;
    grade: string;
  }>,
): Array<{
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  grade: string;
}> {
  const deduped = new Map<string, {
    canonical_slug: string;
    variant_ref: string;
    provider: string;
    grade: string;
  }>();
  for (const key of keys) {
    const dedupeKey = `${key.canonical_slug}::${key.variant_ref}::${key.provider}::${key.grade}`;
    if (!deduped.has(dedupeKey)) deduped.set(dedupeKey, key);
  }
  return [...deduped.values()];
}

async function loadScrydexCardHistoryTargets(params: {
  providerSetId: string;
}): Promise<ScrydexCardHistoryTarget[]> {
  const rows = await loadMatchedProviderCardMapRows([params.providerSetId]);
  return buildScrydexCardHistoryTargets(rows);
}

async function fetchFullScrydexCardPriceHistory(cardId: string, days: number): Promise<ScrydexPriceHistoryDay[]> {
  const credentials = getScrydexCredentials();
  const rows: ScrydexPriceHistoryDay[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await fetchCardPriceHistoryPage(cardId, page, DEFAULT_HISTORY_PAGE_SIZE, credentials, days);
    rows.push(...payload.data);
    if (payload.data.length < payload.pageSize || rows.length >= payload.totalCount) break;
  }
  return rows;
}

export async function backfillScrydexPriceHistoryForSet(opts: {
  providerSetId: string;
  days?: number;
  maxCards?: number;
  dryRun?: boolean;
  refreshRollups?: boolean;
  onlyMissingRecentHistory?: boolean;
}): Promise<ScrydexHistoryBackfillResult> {
  const startedAt = new Date().toISOString();
  const providerSetId = normalizeText(opts.providerSetId);
  const days = Math.max(1, Math.floor(opts.days ?? DEFAULT_HISTORY_DAYS));
  const dryRun = opts.dryRun === true;
  const refreshRollups = opts.refreshRollups !== false;
  const onlyMissingRecentHistory = opts.onlyMissingRecentHistory === true;

  if (!providerSetId) {
    throw new Error("providerSetId is required");
  }

  let cardsFetched = 0;
  let cardsSkippedBudget = 0;
  let cardsSkippedAlreadyCovered = 0;
  let cardsSkippedNoHistory = 0;
  let historyRowsPrepared = 0;
  let historyRowsUpserted = 0;
  let historyRowsSkippedExistingDay = 0;
  let historyRowsSkippedNoNearMint = 0;
  let historyRowsForwardFilled = 0;
  let firstError: string | null = null;
  const sampleWrites: HistoryBackfillSample[] = [];
  const distinctSnapshotDaysWritten = new Set<string>();
  let touchedVariantKeys: Array<{
    canonical_slug: string;
    variant_ref: string;
    provider: string;
    grade: string;
  }> = [];

  const allTargets = await loadScrydexCardHistoryTargets({ providerSetId });
  const variantRefs = normalizeStringList(
    allTargets.flatMap((target) => target.variants.map((variant) => variant.historyVariantRef)),
  );
  const sinceIso = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
  const existingSnapshotState = await loadExistingSnapshotHistoryState(variantRefs, sinceIso);
  const eligibleTargets = onlyMissingRecentHistory
    ? allTargets.filter((target) => target.variants.some((variant) => !existingSnapshotState.variantRefs.has(variant.historyVariantRef)))
    : allTargets;
  cardsSkippedAlreadyCovered = onlyMissingRecentHistory ? Math.max(0, allTargets.length - eligibleTargets.length) : 0;
  const maxCards = opts.maxCards ?? DEFAULT_HISTORY_MAX_CARDS_PER_RUN;
  const targets = typeof maxCards === "number" && Number.isFinite(maxCards) && maxCards > 0
    ? eligibleTargets.slice(0, Math.floor(maxCards))
    : eligibleTargets;
  cardsSkippedBudget = Math.max(0, eligibleTargets.length - targets.length);
  const preparedRows: HistoryWriteRow[] = [];

  try {
    for (const target of targets) {
      cardsFetched += 1;
      let historyDays: ScrydexPriceHistoryDay[] = [];
      try {
        historyDays = await fetchFullScrydexCardPriceHistory(target.providerCardId, days);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isMissingScrydexCardHistoryErrorMessage(message)) {
          cardsSkippedNoHistory += 1;
          continue;
        }
        throw error;
      }

      for (const variant of target.variants) {
        const resolvedHistory = resolveScrydexRawHistoryDays({
          historyDays,
          providerVariantToken: variant.providerVariantToken,
          windowDays: days,
        });
        historyRowsSkippedNoNearMint += resolvedHistory.providerDaysMissingRaw;

        for (const resolvedDay of resolvedHistory.days) {
          const existingDayKey = `${variant.historyVariantRef}::${resolvedDay.dayKey}`;
          if (existingSnapshotState.dayKeys.has(existingDayKey)) {
            historyRowsSkippedExistingDay += 1;
            continue;
          }

          const ts = historyDateToSnapshotTs(resolvedDay.dayKey);
          const row: HistoryWriteRow = {
            canonical_slug: variant.canonicalSlug,
            variant_ref: variant.historyVariantRef,
            provider: PROVIDER,
            ts,
            price: resolvedDay.selected.price,
            currency: resolvedDay.selected.currency,
            source_window: "snapshot",
          };
          preparedRows.push(row);
          if (resolvedDay.source === "carry_forward") {
            historyRowsForwardFilled += 1;
          }
          existingSnapshotState.dayKeys.add(existingDayKey);
          existingSnapshotState.variantRefs.add(variant.historyVariantRef);
          distinctSnapshotDaysWritten.add(existingDayKey);

          if (sampleWrites.length < 25) {
            sampleWrites.push({
              providerSetId,
              providerCardId: target.providerCardId,
              providerVariantId: variant.providerVariantId,
              canonicalSlug: variant.canonicalSlug,
              ts,
              price: resolvedDay.selected.price,
              currency: resolvedDay.selected.currency,
            });
          }
        }
      }
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  const dedupedRows = [...new Map(
    preparedRows.map((row) => [`${row.provider}|${row.variant_ref}|${row.ts}|${row.source_window}`, row] as const),
  ).values()];
  historyRowsPrepared = dedupedRows.length;

  if (!dryRun && firstError === null && dedupedRows.length > 0) {
    const supabase = dbAdmin();
    const writeChunks = chunkValues(dedupedRows, WRITE_CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < writeChunks.length; chunkIndex += 1) {
      const chunk = writeChunks[chunkIndex];
      try {
        const data = await retryHistoryWriteOperation(
          `price_history_points(upsert history backfill chunk ${chunkIndex + 1}/${writeChunks.length})`,
          async () => {
            const { data, error } = await supabase
              .from("price_history_points")
              .upsert(chunk, { onConflict: "provider,variant_ref,ts,source_window" })
              .select("id");
            if (error) throw new Error(error.message);
            return (data ?? []) as Array<{ id: string }>;
          },
          {
            maxAttempts: DEFAULT_HISTORY_WRITE_RETRY_ATTEMPTS,
            baseBackoffMs: DEFAULT_HISTORY_WRITE_RETRY_BACKOFF_MS,
          },
        );
        historyRowsUpserted += data.length;
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
        break;
      }
      touchedVariantKeys = touchedVariantKeys.concat(chunk.map((row) => ({
        canonical_slug: row.canonical_slug,
        variant_ref: row.variant_ref,
        provider: row.provider,
        grade: "RAW",
      })));
    }
  }

  touchedVariantKeys = mergeTouchedVariantKeys(touchedVariantKeys);

  if (!dryRun && firstError === null && refreshRollups && touchedVariantKeys.length > 0) {
    const rollups = await refreshPipelineRollupsForVariantKeys({ keys: touchedVariantKeys });
    if (!rollups.ok) {
      firstError = rollups.firstError ?? "refreshPipelineRollupsForVariantKeys failed";
    }
  }

  const endedAt = new Date().toISOString();
  return {
    ok: firstError === null,
    provider: PROVIDER,
    providerSetId,
    days,
    dryRun,
    startedAt,
    endedAt,
    cardsPlanned: targets.length,
    cardsFetched,
    cardsSkippedBudget,
    cardsSkippedAlreadyCovered,
    cardsSkippedNoHistory,
    estimatedCreditsPlanned: targets.length * SCRYDEX_HISTORY_CREDITS_PER_CARD,
    estimatedCreditsUsed: cardsFetched * SCRYDEX_HISTORY_CREDITS_PER_CARD,
    historyRowsPrepared,
    historyRowsUpserted,
    historyRowsSkippedExistingDay,
    historyRowsSkippedNoNearMint,
    historyRowsForwardFilled,
    distinctSnapshotDaysWritten: distinctSnapshotDaysWritten.size,
    sampleWrites,
    touchedVariantKeys,
    firstError,
  };
}
