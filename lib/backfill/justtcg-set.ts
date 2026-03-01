import crypto from "node:crypto";
import { buildRawVariantRef } from "@/lib/identity/variant-ref";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import {
  fetchJustTcgCardsPage,
  mapJustTcgPrinting,
  mapVariantToMetrics,
  normalizeJustTcgEpochToIso,
  normalizeCardNumber,
  normalizeCondition,
  setNameToJustTcgId,
  type JustTcgCard,
  type JustTcgVariant,
} from "@/lib/providers/justtcg";

const PROVIDER = "JUSTTCG";
const JOB = "backfill_justtcg_set";
const MAX_PAGES = 50;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURE_SAMPLES = 25;
const MAX_SUCCESS_SAMPLES = 10;
const SIGNAL_REFRESH_BATCH_SIZE = 100;

export type BackfillJustTcgSetOptions = {
  language?: "EN";
  aggressive?: boolean;
  dryRun?: boolean;
  providerSetIdOverride?: string;
};
type ErrorCode =
  | "MISSING_CANONICAL_PRINTING"
  | "NO_PROVIDER_MATCH"
  | "AMBIGUOUS_PROVIDER_MATCH"
  | "PROVIDER_FETCH_FAILED"
  | "PROVIDER_PAYLOAD_INVALID"
  | "DB_UPSERT_FAILED";
type PrintingContext = {
  id: string; canonical_slug: string; card_number: string | null; finish: string; edition: string; stamp: string | null;
  language: string; set_code: string | null; set_name: string | null;
};
type CanonicalContext = { slug: string; canonical_name: string | null; subject: string | null; set_name: string | null; card_number: string | null };
type MappingCandidate = { card: JustTcgCard; variant: JustTcgVariant; score: number; notes: string[] };
type BackfillFailure = { canonical_slug: string; printing_id: string; code: ErrorCode; detail: string; sample?: Record<string, unknown> };
type HistoryRow = {
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  ts: string;
  price: number;
  currency: string;
  source_window: "7d" | "30d" | "90d" | "365d" | "full";
};
export type BackfillJustTcgSetResult = {
  ok: boolean; runId: string | null; setKey: string; canonicalSetName: string; providerSetId: string; language: "EN";
  aggressive: boolean; dryRun: boolean; providerWindowRequested: string; providerWindowUsed: string; providerRequestsUsed: number;
  providerSetIdOverride: string | null;
  printingsSelected: number; matchedCount: number; mappingUpserts: number; marketLatestWritten: number; historyPointsWritten: number;
  variantMetricsWritten: number; signalsRowsUpdated: number; noMatchCount: number; hardFailCount: number;
  errorCounts: Record<ErrorCode, number>; failures: BackfillFailure[]; createdMappings: Array<Record<string, unknown>>; firstError: string | null;
};

function requestHash(provider: string, endpoint: string, params: Record<string, unknown>) {
  return crypto.createHash("sha256").update(JSON.stringify({ provider, endpoint, params })).digest("hex").slice(0, 16);
}
function normalizeName(value: string | null | undefined) {
  return (value ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeStampToken(value: string | null | undefined) {
  const normalized = normalizeName(value);
  if (!normalized) return null;
  if (normalized === "poke ball") return "POKE_BALL_PATTERN";
  if (normalized === "master ball") return "MASTER_BALL_PATTERN";
  if (normalized === "energy symbol pattern") return "ENERGY_SYMBOL_PATTERN";
  return normalized.replace(/\s+/g, "_").toUpperCase();
}
function parseProviderCardStamp(name: string) {
  const parentheticalMatch = name.match(/\(([^()]+)\)\s*$/u);
  if (parentheticalMatch?.[1]) {
    return normalizeStampToken(parentheticalMatch[1]);
  }
  const bareSuffixMatch = name.match(/\s+(Poke Ball|Master Ball|Energy Symbol Pattern)\s*$/iu);
  if (bareSuffixMatch?.[1]) {
    return normalizeStampToken(bareSuffixMatch[1]);
  }
  return null;
}
function stripProviderCardVariantSuffix(name: string) {
  return name
    .replace(/\s*\([^()]+\)\s*$/u, "")
    .replace(/\s+(?:Poke Ball|Master Ball|Energy Symbol Pattern)\s*$/iu, "")
    .trim();
}
function toEpochMillis(raw: number | null | undefined) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw >= 1_000_000_000_000 ? raw : raw * 1000;
}
function toIsoFromEpoch(raw: number | null | undefined) {
  return normalizeJustTcgEpochToIso(raw);
}
function toObservedAt(raw: number | null | undefined, fallbackIso: string) {
  return toIsoFromEpoch(raw) ?? fallbackIso;
}
function inferSetDisplayName(setKey: string) {
  return setKey.replace(/-pokemon$/i, "").split("-").filter(Boolean).map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");
}
function summarizeVariant(variant: JustTcgVariant) {
  return {
    id: variant.id,
    printing: variant.printing ?? null,
    condition: variant.condition ?? null,
    language: variant.language ?? null,
    price: variant.price ?? null,
    lastUpdated: variant.lastUpdated ?? null,
    trendSlope7d: variant.trendSlope7d ?? null,
    covPrice30d: variant.covPrice30d ?? null,
    priceRelativeTo30dRange: variant.priceRelativeTo30dRange ?? null,
    priceChangesCount30d: variant.priceChangesCount30d ?? null,
    historyPoints: { total: variant.priceHistory?.length ?? 0, fallback30d: variant.priceHistory30d?.length ?? 0 },
  };
}
function buildHistoryRows(
  variant: JustTcgVariant,
  canonicalSlug: string,
  variantRef: string,
  sourceWindow: "7d" | "30d" | "90d" | "365d" | "full",
): HistoryRow[] {
  const history = (variant.priceHistory?.length ?? 0) > 0 ? variant.priceHistory ?? [] : variant.priceHistory30d ?? [];
  if (history.length === 0) return [];
  const cutoffMs = Date.now() - THIRTY_DAYS_MS;
  const rows: HistoryRow[] = [];

  for (const point of history) {
    if (point.p <= 0) continue;
    const tsIso = toIsoFromEpoch(point.t);
    if (!tsIso) continue;

    rows.push({
      canonical_slug: canonicalSlug,
      variant_ref: variantRef,
      provider: PROVIDER,
      ts: tsIso,
      price: point.p,
      currency: "USD",
      source_window: sourceWindow,
    });

    if (sourceWindow !== "30d" && sourceWindow !== "7d") {
      const tsMs = toEpochMillis(point.t);
      if (tsMs && tsMs >= cutoffMs) {
        rows.push({
          canonical_slug: canonicalSlug,
          variant_ref: variantRef,
          provider: PROVIDER,
          ts: tsIso,
          price: point.p,
          currency: "USD",
          source_window: "30d",
        });
      }
    }
  }

  return rows;
}
function scoreCandidate(params: { card: JustTcgCard; variant: JustTcgVariant; printing: PrintingContext; canonical: CanonicalContext }) {
  const { card, variant, printing, canonical } = params;
  const expectedNumber = normalizeCardNumber(printing.card_number ?? canonical.card_number ?? "");
  const providerNumber = normalizeCardNumber(card.number);
  if (expectedNumber && providerNumber !== expectedNumber) return { score: -1, notes: ["number_mismatch"] };
  const providerFinish = mapJustTcgPrinting(variant.printing ?? "");
  if (printing.finish !== "UNKNOWN" && providerFinish !== printing.finish) return { score: -1, notes: ["finish_mismatch"] };
  const expectedStamp = normalizeStampToken(printing.stamp);
  const providerStamp = parseProviderCardStamp(card.name);
  if (expectedStamp && providerStamp !== expectedStamp) return { score: -1, notes: ["stamp_mismatch"] };
  if (!expectedStamp && providerStamp) return { score: -1, notes: ["unexpected_stamp"] };
  const language = (variant.language ?? "English").trim().toLowerCase();
  if (language !== "english") return { score: -1, notes: ["language_mismatch"] };
  let score = 0;
  const notes: string[] = [];
  if (expectedNumber && providerNumber === expectedNumber) { score += 100; notes.push("number_match"); }
  if (providerFinish === printing.finish) { score += 50; notes.push("finish_match"); }
  if (expectedStamp && providerStamp === expectedStamp) { score += 40; notes.push("stamp_match"); }
  else if (!expectedStamp && !providerStamp) { score += 10; notes.push("base_variant"); }
  const expectedName = normalizeName(canonical.subject ?? canonical.canonical_name ?? canonical.slug);
  const providerName = normalizeName(stripProviderCardVariantSuffix(card.name));
  if (expectedName && providerName === expectedName) { score += 35; notes.push("name_exact"); }
  else if (expectedName && providerName.includes(expectedName)) { score += 20; notes.push("name_contains"); }
  const normalizedCondition = normalizeCondition(variant.condition ?? "");
  if (normalizedCondition === "nm") { score += 20; notes.push("nm_condition"); }
  else if (normalizedCondition === "lp") { score += 15; notes.push("lp_condition"); }
  else if (normalizedCondition === "mp") { score += 10; notes.push("mp_condition"); }
  else if (normalizedCondition === "hp") { score += 5; notes.push("hp_condition"); }
  score += 15;
  notes.push("english_language");
  return { score, notes };
}

function evaluateCandidateRejection(params: {
  card: JustTcgCard;
  variant: JustTcgVariant;
  printing: PrintingContext;
  canonical: CanonicalContext;
}) {
  const { card, variant, printing, canonical } = params;
  const reasons: string[] = [];
  const expectedNumber = normalizeCardNumber(printing.card_number ?? canonical.card_number ?? "");
  const providerNumber = normalizeCardNumber(card.number);
  if (expectedNumber && providerNumber !== expectedNumber) reasons.push("card_number_mismatch");

  const providerFinish = mapJustTcgPrinting(variant.printing ?? "");
  if (printing.finish !== "UNKNOWN" && providerFinish !== printing.finish) reasons.push("finish_mismatch");

  const language = (variant.language ?? "English").trim().toLowerCase();
  if (language !== "english") reasons.push("language_mismatch");

  if (!variant.price || variant.price <= 0) reasons.push("missing_price");

  const expectedName = normalizeName(canonical.subject ?? canonical.canonical_name ?? canonical.slug);
  const providerName = normalizeName(card.name);
  let proximityScore = 0;
  if (expectedNumber && providerNumber === expectedNumber) proximityScore += 40;
  if (providerFinish === printing.finish) proximityScore += 25;
  if (expectedName && providerName === expectedName) proximityScore += 20;
  else if (expectedName && providerName.includes(expectedName)) proximityScore += 10;
  if (language === "english") proximityScore += 5;

  return {
    rejected: reasons.length > 0,
    reasons,
    proximityScore,
  };
}

function buildRejectedCandidatesSample(params: {
  cards: JustTcgCard[];
  printing: PrintingContext;
  canonical: CanonicalContext;
  limit?: number;
}) {
  const { cards, printing, canonical, limit = 5 } = params;
  const samples: Array<Record<string, unknown>> = [];

  for (const card of cards) {
    for (const variant of card.variants ?? []) {
      const evaluation = evaluateCandidateRejection({ card, variant, printing, canonical });
      if (!evaluation.rejected) continue;
      samples.push({
        provider_card_id: card.id,
        provider_variant_id: variant.id,
        provider_name: card.name,
        provider_number: card.number,
        provider_printing: variant.printing ?? null,
        provider_language: variant.language ?? null,
        rejection_reasons: evaluation.reasons,
        proximity_score: evaluation.proximityScore,
      });
    }
  }

  return samples
    .sort((a, b) =>
      Number(b.proximity_score ?? 0) - Number(a.proximity_score ?? 0)
      || String(a.provider_variant_id ?? "").localeCompare(String(b.provider_variant_id ?? ""))
    )
    .slice(0, limit);
}
async function batchUpsert(table: string, rows: Record<string, unknown>[], onConflict: string, batchSize = 250) {
  if (rows.length === 0) return { upserted: 0, firstError: null as string | null };
  const supabase = getServerSupabaseClient();
  let upserted = 0;
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) { firstError ??= `${table}: ${error.message}`; continue; }
    upserted += batch.length;
  }
  return { upserted, firstError };
}
async function batchInsertIgnore(table: string, rows: Record<string, unknown>[], onConflict: string, selectColumn?: string, batchSize = 500) {
  if (rows.length === 0) return { inserted: 0, firstError: null as string | null };
  const supabase = getServerSupabaseClient();
  let inserted = 0;
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const query = supabase.from(table).upsert(batch, { onConflict, ignoreDuplicates: true });
    const response = selectColumn ? await query.select(selectColumn) : await query;
    const { data, error } = response as { data: Array<unknown> | null; error: { message: string } | null };
    if (error) { firstError ??= `${table}: ${error.message}`; continue; }
    inserted += selectColumn ? ((data as Array<unknown> | null)?.length ?? 0) : batch.length;
  }
  return { inserted, firstError };
}
async function refreshSignalsInBatches(keys: Array<Record<string, unknown>>) {
  if (keys.length === 0) return { rowsUpdated: 0, firstError: null as string | null };
  const supabase = getServerSupabaseClient();
  let rowsUpdated = 0;
  let firstError: string | null = null;

  for (let i = 0; i < keys.length; i += SIGNAL_REFRESH_BATCH_SIZE) {
    const batch = keys.slice(i, i + SIGNAL_REFRESH_BATCH_SIZE);
    const { data, error } = await supabase.rpc("refresh_derived_signals_for_variants", { keys: batch });
    if (error) {
      firstError ??= error.message;
      continue;
    }
    rowsUpdated += Number((data as { rowsUpdated?: number } | null)?.rowsUpdated ?? 0);
  }

  return { rowsUpdated, firstError };
}
async function fetchCardsForWindow(providerSetId: string, requestedWindow: string, endpointLabel: string) {
  const pages: JustTcgCard[] = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const nowIso = new Date().toISOString();
  let providerRequestsUsed = 0;
  let firstError: string | null = null;
  let page = 1;
  const currentWindow = requestedWindow;
  let expectedTotal: number | null = null;
  const seenCardIds = new Set<string>();
  while (page <= MAX_PAGES) {
    providerRequestsUsed += 1;
    const result = await fetchJustTcgCardsPage(providerSetId, page, { limit: 200, priceHistoryDuration: currentWindow });
    const envelopeMeta = (
      result.rawEnvelope
      && typeof result.rawEnvelope === "object"
      && "meta" in result.rawEnvelope
      && result.rawEnvelope.meta
      && typeof result.rawEnvelope.meta === "object"
    ) ? (result.rawEnvelope.meta as { total?: number; limit?: number; offset?: number; hasMore?: boolean }) : null;
    if (typeof envelopeMeta?.total === "number" && Number.isFinite(envelopeMeta.total) && envelopeMeta.total > 0) {
      expectedTotal = envelopeMeta.total;
    }
    let pageNewCardCount = 0;
    for (const card of result.cards) {
      if (!seenCardIds.has(card.id)) {
        seenCardIds.add(card.id);
        pageNewCardCount += 1;
      }
    }
    auditRows.push({
      provider: PROVIDER, endpoint: "/cards/backfill-set-page",
      params: { set: providerSetId, page, limit: 200, priceHistoryDuration: currentWindow },
      response: {
        providerSetId, page, httpStatus: result.httpStatus, cardsInPage: result.cards.length, hasMore: result.hasMore,
        expectedTotal,
        pageNewCardCount,
        sample: result.cards.slice(0, 3).map((card) => ({ id: card.id, name: card.name, number: card.number, variants: (card.variants ?? []).slice(0, 2).map((variant) => summarizeVariant(variant)) })),
      },
      status_code: result.httpStatus,
      fetched_at: nowIso,
      request_hash: requestHash(PROVIDER, endpointLabel, { set: providerSetId, page, limit: 200, priceHistoryDuration: currentWindow }),
      canonical_slug: null,
      variant_ref: null,
    });
    if (result.httpStatus < 200 || result.httpStatus >= 300) {
      firstError = `JustTCG set fetch failed (${providerSetId} page ${page}): HTTP ${result.httpStatus}`;
      break;
    }
    pages.push(...result.cards);
    const hitExpectedTotal = expectedTotal !== null && seenCardIds.size >= expectedTotal;
    const shortOrEmptyPage = result.cards.length < 200;
    const repeatedPage = result.cards.length > 0 && pageNewCardCount === 0;
    if (!result.hasMore || hitExpectedTotal || shortOrEmptyPage || repeatedPage) break;
    page += 1;
  }
  if (!firstError && pages.length === 0) {
    firstError = `JustTCG returned 0 cards for set ${providerSetId}`;
  }
  if (page > MAX_PAGES) firstError = `JustTCG set fetch exceeded ${MAX_PAGES} pages for ${providerSetId}`;
  return { cards: pages, auditRows, providerRequestsUsed, firstError };
}

async function fetchSetCards(providerSetId: string, aggressive: boolean) {
  const providerWindowRequested = aggressive ? "all" : "30d";
  let providerWindowUsed = providerWindowRequested;

  let primary = await fetchCardsForWindow(providerSetId, providerWindowRequested, "/cards/backfill-set-page");
  if (providerWindowRequested === "all" && primary.firstError) {
    providerWindowUsed = "365d";
    primary = await fetchCardsForWindow(providerSetId, "365d", "/cards/backfill-set-page");
    if (primary.firstError) {
      providerWindowUsed = "90d";
      primary = await fetchCardsForWindow(providerSetId, "90d", "/cards/backfill-set-page");
      if (primary.firstError) {
        providerWindowUsed = "30d";
        primary = await fetchCardsForWindow(providerSetId, "30d", "/cards/backfill-set-page");
      }
    }
  }

  let history7dCards: JustTcgCard[] = [];
  let history7dAuditRows: Array<Record<string, unknown>> = [];
  let history7dRequestsUsed = 0;
  let history7dError: string | null = null;

  if (!primary.firstError && providerWindowUsed !== "7d") {
    const sevenDay = await fetchCardsForWindow(providerSetId, "7d", "/cards/backfill-set-page-7d");
    history7dCards = sevenDay.cards;
    history7dAuditRows = sevenDay.auditRows;
    history7dRequestsUsed = sevenDay.providerRequestsUsed;
    history7dError = sevenDay.firstError;
  }

  return {
    cards: primary.cards,
    auditRows: [...primary.auditRows, ...history7dAuditRows],
    providerRequestsUsed: primary.providerRequestsUsed + history7dRequestsUsed,
    providerWindowRequested,
    providerWindowUsed,
    history7dCards,
    history7dError,
    firstError: primary.firstError,
  };
}

export async function backfillJustTcgSet(setKey: string, options: BackfillJustTcgSetOptions = {}): Promise<BackfillJustTcgSetResult> {
  const supabase = getServerSupabaseClient();
  const language = options.language ?? "EN";
  if (language !== "EN") throw new Error("This backfill currently supports EN only. Re-run with { language: 'EN' }.");
  const dryRun = options.dryRun === true;
  const aggressive = options.aggressive !== false;
  const providerSetIdOverride = (options.providerSetIdOverride ?? "").trim() || null;
  const setKeyNormalized = String(setKey ?? "").trim().toLowerCase();
  if (!setKeyNormalized) throw new Error("A JustTCG set key is required, e.g. 'paldea-evolved'.");
  const canonicalSetNameGuess = inferSetDisplayName(setKeyNormalized);
  const providerSetIdCandidates = Array.from(new Set([setKeyNormalized, setKeyNormalized.endsWith("-pokemon") ? setKeyNormalized : `${setKeyNormalized}-pokemon`]));

  const { data: runRow, error: runError } = await supabase
    .from("ingest_runs")
    .insert({ job: JOB, source: "justtcg", status: "started", ok: false, items_fetched: 0, items_upserted: 0, items_failed: 0, meta: { setKey: setKeyNormalized, language, aggressive, dryRun } })
    .select("id")
    .single<{ id: string }>();
  if (runError) throw new Error(`Insert ingest_runs failed: ${runError.message}`);
  const runId = runRow?.id ?? null;

  let firstError: string | null = null;
  let providerRequestsUsed = 0;
  let providerWindowRequested = aggressive ? "all" : "30d";
  let providerWindowUsed = providerWindowRequested;
  let matchedCount = 0;
  let mappingUpserts = 0;
  let marketLatestWritten = 0;
  let historyPointsWritten = 0;
  let variantMetricsWritten = 0;
  let signalsRowsUpdated = 0;
  let noMatchCount = 0;
  let hardFailCount = 0;
  const failures: BackfillFailure[] = [];
  const createdMappings: Array<Record<string, unknown>> = [];
  const errorCounts: Record<ErrorCode, number> = {
    MISSING_CANONICAL_PRINTING: 0, NO_PROVIDER_MATCH: 0, AMBIGUOUS_PROVIDER_MATCH: 0, PROVIDER_FETCH_FAILED: 0, PROVIDER_PAYLOAD_INVALID: 0, DB_UPSERT_FAILED: 0,
  };
  const pushFailure = (failure: BackfillFailure, hard = false) => {
    if (failures.length < MAX_FAILURE_SAMPLES) failures.push(failure);
    errorCounts[failure.code] += 1;
    if (failure.code === "NO_PROVIDER_MATCH") noMatchCount += 1;
    if (hard) hardFailCount += 1;
    firstError ??= `${failure.code}: ${failure.detail}`;
  };

  try {
    const { data: mappedSetRows } = await supabase.from("provider_set_map").select("canonical_set_code, provider_set_id").eq("provider", PROVIDER).in("provider_set_id", providerSetIdCandidates);
    const canonicalSetCode = mappedSetRows?.[0]?.canonical_set_code ?? null;
    const providerSetId = providerSetIdOverride
      ?? mappedSetRows?.[0]?.provider_set_id
      ?? providerSetIdCandidates.find((candidate) => candidate.endsWith("-pokemon"))
      ?? setNameToJustTcgId(canonicalSetNameGuess);

    let printingsQuery = supabase
      .from("card_printings")
      .select("id, canonical_slug, card_number, finish, edition, stamp, language, set_code, set_name")
      .eq("language", language);
    printingsQuery = canonicalSetCode ? printingsQuery.eq("set_code", canonicalSetCode) : printingsQuery.ilike("set_name", canonicalSetNameGuess);
    const { data: printingRows, error: printingError } = await printingsQuery.order("card_number", { ascending: true });
    if (printingError) throw new Error(`Load card_printings failed: ${printingError.message}`);
    const printings = (printingRows ?? []) as PrintingContext[];
    if (printings.length === 0) {
      throw new Error(`Missing canonical printings for ${canonicalSetNameGuess} (${language}). Run the canonical import first; this backfill never creates canonical_cards or card_printings.`);
    }
    const slugs = Array.from(new Set(printings.map((row) => row.canonical_slug)));
    const { data: canonicalRows, error: canonicalError } = await supabase.from("canonical_cards").select("slug, canonical_name, subject, set_name, card_number").in("slug", slugs);
    if (canonicalError) throw new Error(`Load canonical_cards failed: ${canonicalError.message}`);
    const canonicalBySlug = new Map<string, CanonicalContext>();
    for (const row of (canonicalRows ?? []) as CanonicalContext[]) canonicalBySlug.set(row.slug, row);
    if (canonicalBySlug.size !== slugs.length) {
      throw new Error(`Canonical set is incomplete for ${canonicalSetNameGuess}. Missing ${slugs.length - canonicalBySlug.size} canonical_cards rows; fix canonical import before backfill.`);
    }

    const fetchResult = await fetchSetCards(providerSetId, aggressive);
    providerRequestsUsed = fetchResult.providerRequestsUsed;
    providerWindowRequested = fetchResult.providerWindowRequested;
    providerWindowUsed = fetchResult.providerWindowUsed;
    if (!dryRun && fetchResult.auditRows.length > 0) {
      const { error } = await supabase.from("provider_raw_payloads").insert(fetchResult.auditRows);
      if (error) firstError ??= `provider_raw_payloads: ${error.message}`;
    }
    if (fetchResult.firstError) {
      for (const printing of printings.slice(0, MAX_FAILURE_SAMPLES)) {
        pushFailure({ canonical_slug: printing.canonical_slug, printing_id: printing.id, code: "PROVIDER_FETCH_FAILED", detail: fetchResult.firstError }, true);
      }
      const failedFetchResult: BackfillJustTcgSetResult = {
        ok: false, runId, setKey: setKeyNormalized, canonicalSetName: canonicalSetNameGuess, providerSetId, language, aggressive, dryRun, providerSetIdOverride,
        providerWindowRequested, providerWindowUsed, providerRequestsUsed, printingsSelected: printings.length, matchedCount, mappingUpserts,
        marketLatestWritten, historyPointsWritten, variantMetricsWritten, signalsRowsUpdated, noMatchCount, hardFailCount, errorCounts, failures, createdMappings, firstError,
      };
      await supabase.from("ingest_runs").update({ status: "finished", ok: false, items_fetched: providerRequestsUsed, items_upserted: 0, items_failed: hardFailCount, ended_at: new Date().toISOString(), meta: failedFetchResult }).eq("id", runId);
      return failedFetchResult;
    }

    const cardsByNumber = new Map<string, JustTcgCard[]>();
    for (const card of fetchResult.cards) {
      const key = normalizeCardNumber(card.number);
      const bucket = cardsByNumber.get(key) ?? [];
      bucket.push(card);
      cardsByNumber.set(key, bucket);
    }
    const history7dVariantMap = new Map<string, JustTcgVariant>();
    for (const card of fetchResult.history7dCards ?? []) {
      for (const variant of card.variants ?? []) {
        history7dVariantMap.set(variant.id, variant);
      }
    }

    const mappingRows: Record<string, unknown>[] = [];
    const ingestRows: Record<string, unknown>[] = [];
    const providerRawRows: Record<string, unknown>[] = [];
    const marketLatestRows: Record<string, unknown>[] = [];
    const variantMetricRows: Record<string, unknown>[] = [];
    const historyRows: Record<string, unknown>[] = [];
    const updatedVariantKeys: Array<{ canonical_slug: string; variant_ref: string; provider: string; grade: string }> = [];
    const nowIso = new Date().toISOString();

    for (const printing of printings) {
      const canonical = canonicalBySlug.get(printing.canonical_slug);
      if (!canonical) {
        pushFailure({ canonical_slug: printing.canonical_slug, printing_id: printing.id, code: "MISSING_CANONICAL_PRINTING", detail: "Missing canonical row for printing." }, true);
        continue;
      }
      const expectedNumber = normalizeCardNumber(printing.card_number ?? canonical.card_number ?? "");
      const cardsForNumber = expectedNumber ? cardsByNumber.get(expectedNumber) ?? [] : [];
      if (cardsForNumber.length === 0) {
        pushFailure({
          canonical_slug: printing.canonical_slug,
          printing_id: printing.id,
          code: "NO_PROVIDER_MATCH",
          detail: `No JustTCG card matched card_number ${expectedNumber || "(blank)"}.`,
          sample: {
            local: {
              card_number: expectedNumber || null,
              finish: printing.finish,
              name: canonical.subject ?? canonical.canonical_name ?? canonical.slug,
            },
            top_rejected_candidates: buildRejectedCandidatesSample({
              cards: fetchResult.cards,
              printing,
              canonical,
              limit: 5,
            }),
          },
        });
        ingestRows.push({ provider: PROVIDER, job: JOB, set_id: providerSetId, card_id: printing.id, variant_id: null, canonical_slug: printing.canonical_slug, printing_id: printing.id, raw_payload: { status: "no_match", code: "NO_PROVIDER_MATCH", expectedNumber, finish: printing.finish } });
        continue;
      }

      const candidates: MappingCandidate[] = [];
      for (const card of cardsForNumber) {
        for (const variant of card.variants ?? []) {
          if (!variant.price || variant.price <= 0) continue;
          const ranked = scoreCandidate({ card, variant, printing, canonical });
          if (ranked.score < 0) continue;
          candidates.push({ card, variant, score: ranked.score, notes: ranked.notes });
        }
      }
      candidates.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.variant.id.localeCompare(b.variant.id)));
      if (candidates.length === 0) {
        pushFailure({
          canonical_slug: printing.canonical_slug, printing_id: printing.id, code: "NO_PROVIDER_MATCH",
          detail: "No JustTCG variant matched this printing after finish/language filtering.",
          sample: {
            local: {
              card_number: expectedNumber || null,
              finish: printing.finish,
              name: canonical.subject ?? canonical.canonical_name ?? canonical.slug,
            },
            top_rejected_candidates: buildRejectedCandidatesSample({
              cards: cardsForNumber,
              printing,
              canonical,
              limit: 5,
            }),
          },
        });
        ingestRows.push({ provider: PROVIDER, job: JOB, set_id: providerSetId, card_id: printing.id, variant_id: null, canonical_slug: printing.canonical_slug, printing_id: printing.id, raw_payload: { status: "no_match", code: "NO_PROVIDER_MATCH", expectedNumber, finish: printing.finish } });
        continue;
      }
      const best = candidates[0];
      if (candidates[1] && candidates[1].score === best.score && candidates[1].variant.id !== best.variant.id) {
        pushFailure({
          canonical_slug: printing.canonical_slug, printing_id: printing.id, code: "AMBIGUOUS_PROVIDER_MATCH", detail: "Multiple JustTCG variants tied for top match.",
          sample: { topCandidates: candidates.slice(0, 3).map((candidate) => ({ cardId: candidate.card.id, variantId: candidate.variant.id, score: candidate.score, notes: candidate.notes })) },
        });
        ingestRows.push({ provider: PROVIDER, job: JOB, set_id: providerSetId, card_id: printing.id, variant_id: null, canonical_slug: printing.canonical_slug, printing_id: printing.id, raw_payload: { status: "ambiguous", code: "AMBIGUOUS_PROVIDER_MATCH" } });
        continue;
      }

      matchedCount += 1;
      const variantRef = buildRawVariantRef(printing.id);
      const observedAt = toObservedAt(best.variant.lastUpdated ?? null, nowIso);
      const historyWindow =
        providerWindowUsed === "all"
          ? "full"
          : providerWindowUsed === "365d"
            ? "365d"
            : providerWindowUsed === "90d"
              ? "90d"
              : "30d";
      const historyPointRows = buildHistoryRows(best.variant, printing.canonical_slug, variantRef, historyWindow);
      const history7dVariant = history7dVariantMap.get(best.variant.id) ?? null;
      const history7dRows = history7dVariant
        ? buildHistoryRows(history7dVariant, printing.canonical_slug, variantRef, "7d")
        : [];
      const historyPoints30d = historyPointRows.filter((row) => row.source_window === "30d").length;
      const metrics = mapVariantToMetrics(best.variant, printing.canonical_slug, printing.id, "RAW", observedAt);

      ingestRows.push({
        provider: PROVIDER, job: JOB, set_id: providerSetId, card_id: printing.id, variant_id: best.variant.id, canonical_slug: printing.canonical_slug, printing_id: printing.id,
        raw_payload: { status: dryRun ? "dry_run_match" : "matched", variantRef, provider_card_id: best.card.id, provider_variant_id: best.variant.id, provider_card_number: best.card.number, provider_printing: best.variant.printing ?? null, score: best.score, notes: best.notes },
      });
      providerRawRows.push({
        provider: PROVIDER, endpoint: "/cards/backfill-set-match",
        params: { set: providerSetId, printing_id: printing.id, canonical_slug: printing.canonical_slug, aggressive },
        response: { selected: { provider_card_id: best.card.id, provider_variant_id: best.variant.id, provider_card_number: best.card.number, provider_printing: best.variant.printing ?? null, provider_condition: best.variant.condition ?? null, match_confidence: Math.min(1, best.score / 215), match_notes: best.notes }, pricing: summarizeVariant(best.variant), cached: { historyWindow, historyPoints: historyPointRows.length, historyPoints7d: history7dRows.length } },
        status_code: 200,
        fetched_at: nowIso,
        request_hash: requestHash(PROVIDER, "/cards/backfill-set-match", { set: providerSetId, printing_id: printing.id, variant_id: best.variant.id, aggressive }),
        canonical_slug: printing.canonical_slug,
        variant_ref: variantRef,
      });
      mappingRows.push({
        card_id: best.card.id, source: PROVIDER, mapping_type: "printing", external_id: best.variant.id, canonical_slug: printing.canonical_slug, printing_id: printing.id,
        meta: { provider_set_id: providerSetId, provider_card_id: best.card.id, provider_variant_id: best.variant.id, provider_card_number: best.card.number, provider_printing: best.variant.printing ?? null, match_confidence: Math.min(1, best.score / 215), match_notes: best.notes },
      });
      marketLatestRows.push({
        card_id: best.variant.id, source: PROVIDER, grade: "RAW", price_type: "MARKET", price_usd: best.variant.price, currency: "USD", volume: null, external_id: best.variant.id, url: null,
        observed_at: observedAt, canonical_slug: printing.canonical_slug, printing_id: printing.id, updated_at: nowIso,
      });
      historyRows.push(...historyPointRows, ...history7dRows);

      if (!metrics) {
        pushFailure({ canonical_slug: printing.canonical_slug, printing_id: printing.id, code: "PROVIDER_PAYLOAD_INVALID", detail: "JustTCG variant payload missing required provider analytics fields.", sample: { variantId: best.variant.id } });
      } else {
        variantMetricRows.push({
          canonical_slug: printing.canonical_slug, printing_id: printing.id, variant_ref: variantRef, provider: PROVIDER, grade: "RAW",
          provider_trend_slope_7d: metrics.provider_trend_slope_7d, provider_cov_price_30d: metrics.provider_cov_price_30d,
          provider_price_relative_to_30d_range: metrics.provider_price_relative_to_30d_range, provider_price_changes_count_30d: metrics.provider_price_changes_count_30d,
          provider_as_of_ts: observedAt, history_points_30d: historyPoints30d, signal_trend: null, signal_breakout: null, signal_value: null, signals_as_of_ts: null, updated_at: nowIso,
        });
        updatedVariantKeys.push({ canonical_slug: printing.canonical_slug, variant_ref: variantRef, provider: PROVIDER, grade: "RAW" });
      }
      if (createdMappings.length < MAX_SUCCESS_SAMPLES) {
        createdMappings.push({ canonical_slug: printing.canonical_slug, printing_id: printing.id, external_id: best.variant.id, provider_set_id: providerSetId, provider_card_id: best.card.id, match_confidence: Math.min(1, best.score / 215), match_notes: best.notes });
      }
    }

    if (!dryRun) {
      if (ingestRows.length > 0) {
        const { error } = await supabase.from("provider_ingests").insert(ingestRows);
        if (error) pushFailure({ canonical_slug: printings[0].canonical_slug, printing_id: printings[0].id, code: "DB_UPSERT_FAILED", detail: `provider_ingests: ${error.message}` }, true);
      }
      if (providerRawRows.length > 0) {
        const { error } = await supabase.from("provider_raw_payloads").insert(providerRawRows);
        if (error) pushFailure({ canonical_slug: printings[0].canonical_slug, printing_id: printings[0].id, code: "DB_UPSERT_FAILED", detail: `provider_raw_payloads: ${error.message}` }, true);
      }
      const mappingResult = await batchUpsert("card_external_mappings", mappingRows, "source,mapping_type,printing_id");
      mappingUpserts = mappingResult.upserted;
      if (mappingResult.firstError) pushFailure({ canonical_slug: printings[0].canonical_slug, printing_id: printings[0].id, code: "DB_UPSERT_FAILED", detail: mappingResult.firstError }, true);
      const marketLatestResult = await batchUpsert("market_latest", marketLatestRows, "card_id,source,grade,price_type");
      marketLatestWritten = marketLatestResult.upserted;
      if (marketLatestResult.firstError) pushFailure({ canonical_slug: printings[0].canonical_slug, printing_id: printings[0].id, code: "DB_UPSERT_FAILED", detail: marketLatestResult.firstError }, true);
      const historyResult = await batchInsertIgnore("price_history_points", historyRows, "provider,variant_ref,ts,source_window", "ts");
      historyPointsWritten = historyResult.inserted;
      if (historyResult.firstError) pushFailure({ canonical_slug: printings[0].canonical_slug, printing_id: printings[0].id, code: "DB_UPSERT_FAILED", detail: historyResult.firstError }, true);
      const variantMetricsResult = await batchUpsert("variant_metrics", variantMetricRows, "canonical_slug,printing_id,provider,grade");
      variantMetricsWritten = variantMetricsResult.upserted;
      if (variantMetricsResult.firstError) pushFailure({ canonical_slug: printings[0].canonical_slug, printing_id: printings[0].id, code: "DB_UPSERT_FAILED", detail: variantMetricsResult.firstError }, true);
      if (updatedVariantKeys.length > 0) {
        const { rowsUpdated, firstError: batchSignalError } = await refreshSignalsInBatches(updatedVariantKeys);
        if (batchSignalError) {
          const { data: fallbackData, error: fallbackError } = await supabase.rpc("refresh_derived_signals");
          if (fallbackError) pushFailure({ canonical_slug: printings[0].canonical_slug, printing_id: printings[0].id, code: "DB_UPSERT_FAILED", detail: `signals refresh failed: ${fallbackError.message}` }, true);
          else signalsRowsUpdated = Number((fallbackData as { rowsUpdated?: number } | null)?.rowsUpdated ?? (fallbackData as number | null) ?? 0);
        } else {
          signalsRowsUpdated = rowsUpdated;
        }
      }
    }

    const result: BackfillJustTcgSetResult = {
      ok: hardFailCount === 0, runId, setKey: setKeyNormalized, canonicalSetName: printings[0]?.set_name ?? canonicalSetNameGuess, providerSetId, language, aggressive, dryRun, providerSetIdOverride,
      providerWindowRequested, providerWindowUsed, providerRequestsUsed, printingsSelected: printings.length, matchedCount, mappingUpserts, marketLatestWritten,
      historyPointsWritten, variantMetricsWritten, signalsRowsUpdated, noMatchCount, hardFailCount, errorCounts, failures, createdMappings, firstError,
    };
    const itemsUpserted = dryRun ? matchedCount : mappingUpserts + marketLatestWritten + historyPointsWritten + variantMetricsWritten;
    await supabase.from("ingest_runs").update({ status: "finished", ok: result.ok, items_fetched: providerRequestsUsed, items_upserted: itemsUpserted, items_failed: hardFailCount, ended_at: new Date().toISOString(), meta: result }).eq("id", runId);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    firstError ??= message;
    const failedResult: BackfillJustTcgSetResult = {
      ok: false,
      runId,
      setKey: setKeyNormalized,
      canonicalSetName: canonicalSetNameGuess,
      providerSetId: providerSetIdCandidates.find((candidate) => candidate.endsWith("-pokemon")) ?? setNameToJustTcgId(canonicalSetNameGuess),
      language,
      aggressive,
      dryRun,
      providerSetIdOverride,
      providerWindowRequested,
      providerWindowUsed,
      providerRequestsUsed,
      printingsSelected: 0,
      matchedCount,
      mappingUpserts,
      marketLatestWritten,
      historyPointsWritten,
      variantMetricsWritten,
      signalsRowsUpdated,
      noMatchCount,
      hardFailCount: hardFailCount + 1,
      errorCounts,
      failures,
      createdMappings,
      firstError,
    };
    await supabase.from("ingest_runs").update({ status: "finished", ok: false, items_fetched: providerRequestsUsed, items_upserted: 0, items_failed: failedResult.hardFailCount, ended_at: new Date().toISOString(), meta: failedResult }).eq("id", runId);
    return failedResult;
  }
}
