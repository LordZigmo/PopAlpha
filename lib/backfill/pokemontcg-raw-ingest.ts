import crypto from "node:crypto";
import { dbAdmin } from "@/lib/db/admin";
import { fetchCardsPage, getScrydexCredentials, type ScrydexCard } from "@/lib/scrydex/client";
import {
  loadCoverageGapSetPriority,
  loadHighValueStaleSetPriority,
  loadRecentSetConsistencyPriority,
} from "@/lib/backfill/set-priority";
import { isPhysicalPokemonSet } from "@/lib/sets/physical";
import {
  getProviderCooldownState,
  isProviderCreditCapError,
  markProviderCreditCapCooldown,
} from "@/lib/backfill/provider-cooldown";

const PROVIDER = "SCRYDEX";
const JOB = "scrydex_raw_ingest";
const ENDPOINT = "/en/expansions/{id}/cards";
const PAGE_LIMIT = 100;
const DEFAULT_SETS_PER_RUN = process.env.SCRYDEX_RAW_SETS_PER_RUN
  ? parseInt(process.env.SCRYDEX_RAW_SETS_PER_RUN, 10)
  : 10;
const DEFAULT_MAX_REQUESTS = process.env.SCRYDEX_RAW_MAX_REQUESTS
  ? parseInt(process.env.SCRYDEX_RAW_MAX_REQUESTS, 10)
  : 200;
const DEFAULT_RETRY_ATTEMPTS = process.env.SCRYDEX_RAW_RETRY_ATTEMPTS
  ? parseInt(process.env.SCRYDEX_RAW_RETRY_ATTEMPTS, 10)
  : 3;
const DEFAULT_RETRY_BACKOFF_MS = process.env.SCRYDEX_RAW_RETRY_BACKOFF_MS
  ? parseInt(process.env.SCRYDEX_RAW_RETRY_BACKOFF_MS, 10)
  : 750;
const DEFAULT_COOLDOWN_MINUTES = process.env.SCRYDEX_RAW_COOLDOWN_MINUTES
  ? parseInt(process.env.SCRYDEX_RAW_COOLDOWN_MINUTES, 10)
  : 180;
const DEFAULT_FAILED_QUEUE_LIMIT = process.env.SCRYDEX_FAILED_SET_QUEUE_LIMIT
  ? parseInt(process.env.SCRYDEX_FAILED_SET_QUEUE_LIMIT, 10)
  : 200;
const HOT_SLOT_INTERVAL = process.env.SCRYDEX_HOT_SLOT_INTERVAL
  ? Math.max(2, parseInt(process.env.SCRYDEX_HOT_SLOT_INTERVAL, 10))
  : 6;
const HOT_SET_LIMIT = process.env.SCRYDEX_HOT_SET_LIMIT
  ? Math.max(1, parseInt(process.env.SCRYDEX_HOT_SET_LIMIT, 10))
  : 10;
const PINNED_HOT_SET_IDS = (() => {
  const defaults = ["sv3pt5"];
  const configured = String(process.env.SCRYDEX_PINNED_HOT_SET_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return normalizeStringList([...defaults, ...configured]);
})();
const MAX_SETS_PER_RUN_CAP = process.env.SCRYDEX_RAW_SETS_PER_RUN_CAP
  ? parseInt(process.env.SCRYDEX_RAW_SETS_PER_RUN_CAP, 10)
  : 6;
const MAX_PAGE_LIMIT_PER_SET_CAP = process.env.SCRYDEX_RAW_PAGE_LIMIT_PER_SET_CAP
  ? parseInt(process.env.SCRYDEX_RAW_PAGE_LIMIT_PER_SET_CAP, 10)
  : 12;
const MAX_REQUESTS_PER_RUN_CAP = process.env.SCRYDEX_RAW_MAX_REQUESTS_CAP
  ? parseInt(process.env.SCRYDEX_RAW_MAX_REQUESTS_CAP, 10)
  : 60;

type CanonicalSet = {
  setCode: string;
  setName: string;
  providerSetId?: string | null;
};

type ProviderSetMapRow = {
  canonical_set_code: string;
  canonical_set_name: string | null;
  provider_set_id: string;
};

type LastRunRow = {
  meta: Record<string, unknown> | null;
};

type ProviderSetHealthRow = {
  provider: string;
  provider_set_id: string;
  canonical_set_code: string | null;
  canonical_set_name: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_429_at: string | null;
  last_status_code: number | null;
  consecutive_429: number | null;
  cooldown_until: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  requests_last_run: number | null;
  pages_last_run: number | null;
  cards_last_run: number | null;
  updated_at: string | null;
};

type ProviderSetHealthUpsertRow = {
  provider: string;
  provider_set_id: string;
  canonical_set_code: string | null;
  canonical_set_name: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_429_at: string | null;
  last_status_code: number | null;
  consecutive_429: number;
  cooldown_until: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  requests_last_run: number;
  pages_last_run: number;
  cards_last_run: number;
  updated_at: string;
};

type IngestTarget = {
  setCode: string | null;
  setName: string | null;
  providerSetId: string;
};

type IngestRunState = {
  cursorSetCode: string | null;
  hotCursorProviderSetId: string | null;
  selectionPhase: number;
  failedSetQueue: string[];
  cooldownByProviderSet: Record<string, string>;
};

type RawIngestSetSummary = {
  canonicalSetCode: string | null;
  canonicalSetName: string | null;
  providerSetId: string;
  pagesFetched: number;
  cardsFetched: number;
  lastStatus: number | null;
  hasMore: boolean;
};

type RawIngestResult = {
  ok: boolean;
  job: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  setsPlanned: number;
  setsProcessed: number;
  selectedProviderSetIds: string[];
  requestsMade: number;
  rawPayloadsInserted: number;
  rawPayloadsDuplicate: number;
  cardsFetched: number;
  failedRequests: number;
  pageLimit: number;
  sampleSetResults: RawIngestSetSummary[];
  warningCount: number;
  warningSamples: string[];
  skippedCooldownSets: number;
  skippedCooldownSamples: string[];
  firstError: string | null;
};

type TargetSelectionPlan = {
  selectedTargets: IngestTarget[];
  nextSetCode: string | null;
  nextHotProviderSetId: string | null;
  nextSelectionPhase: number;
  hotSlotCount: number;
  baselineSlotCount: number;
  hotProviderSetIds: string[];
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeStringList(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function requestHash(endpoint: string, params: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ provider: PROVIDER, endpoint, params }))
    .digest("hex")
    .slice(0, 16);
}

function responseHash(body: unknown): string {
  return crypto
    .createHash("md5")
    .update(JSON.stringify(body ?? {}))
    .digest("hex");
}

function isDuplicateInsertError(message: string | null | undefined): boolean {
  const text = String(message ?? "").toLowerCase();
  return text.includes("duplicate") || text.includes("unique");
}

function delayMs(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableScrydexError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes(" 522")
    || text.includes("timed out")
    || text.includes("timeout")
    || text.includes("fetch failed")
    || text.includes("network")
    || text.includes("socket")
    || text.includes("econnreset")
    || text.includes("etimedout")
    || text.includes("eai_again");
}

function rotateItemsFromCursor<T>(params: {
  items: T[];
  limit: number;
  cursor: string | null;
  getKey: (item: T) => string;
}): T[] {
  if (params.items.length === 0) return [];
  const limit = Math.min(Math.max(1, params.limit), params.items.length);
  const cursor = String(params.cursor ?? "").trim();
  if (!cursor) return params.items.slice(0, limit);

  const cursorIndex = params.items.findIndex((item) => params.getKey(item) === cursor);
  const startIndex = cursorIndex >= 0 ? (cursorIndex + 1) % params.items.length : 0;
  const output: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    output.push(params.items[(startIndex + i) % params.items.length]);
  }
  return output;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function parseCooldownMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key || typeof raw !== "string") continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    output[key] = raw;
  }
  return output;
}

async function loadLastRunState(): Promise<IngestRunState> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("ingest_runs")
    .select("meta")
    .eq("job", JOB)
    .eq("status", "finished")
    .order("ended_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(`ingest_runs(last state): ${error.message}`);

  let meta: Record<string, unknown> = {};
  for (const row of ((data ?? []) as LastRunRow[])) {
    const candidate = row.meta ?? {};
    const providerSetId = typeof candidate.providerSetId === "string"
      ? candidate.providerSetId.trim()
      : "";
    if (providerSetId) continue;
    meta = candidate;
    break;
  }
  const cursorRaw = typeof meta.nextSetCode === "string"
    ? meta.nextSetCode
    : (typeof meta.cursorSetCode === "string" ? meta.cursorSetCode : "");
  const hotCursorRaw = typeof meta.nextHotProviderSetId === "string"
    ? meta.nextHotProviderSetId
    : (typeof meta.hotCursorProviderSetId === "string" ? meta.hotCursorProviderSetId : "");
  const selectionPhaseRaw = typeof meta.nextSelectionPhase === "number"
    ? meta.nextSelectionPhase
    : (typeof meta.selectionPhase === "number" ? meta.selectionPhase : 0);
  return {
    cursorSetCode: cursorRaw.trim() || null,
    hotCursorProviderSetId: hotCursorRaw.trim() || null,
    selectionPhase: Number.isFinite(selectionPhaseRaw) ? Math.max(0, Math.floor(selectionPhaseRaw)) : 0,
    failedSetQueue: parseStringArray(meta.failedSetQueue),
    cooldownByProviderSet: parseCooldownMap(meta.cooldownByProviderSet),
  };
}

function normalizeFailedSetQueue(queue: string[]): string[] {
  const unique = new Set<string>();
  const output: string[] = [];
  for (const value of queue) {
    const trimmed = value.trim();
    if (!trimmed || unique.has(trimmed)) continue;
    unique.add(trimmed);
    output.push(trimmed);
  }
  return output.slice(0, DEFAULT_FAILED_QUEUE_LIMIT);
}

function isSetInCooldown(params: {
  providerSetId: string;
  cooldownByProviderSet: Record<string, string>;
  nowMs: number;
}): { active: boolean; untilIso: string | null } {
  const untilIso = params.cooldownByProviderSet[params.providerSetId] ?? null;
  if (!untilIso) return { active: false, untilIso: null };
  const untilMs = Date.parse(untilIso);
  if (!Number.isFinite(untilMs)) return { active: false, untilIso: null };
  if (untilMs <= params.nowMs) return { active: false, untilIso };
  return { active: true, untilIso };
}

function pruneCooldowns(cooldownByProviderSet: Record<string, string>, nowMs: number): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [providerSetId, untilIso] of Object.entries(cooldownByProviderSet)) {
    const untilMs = Date.parse(untilIso);
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) continue;
    output[providerSetId] = untilIso;
  }
  return output;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function maxIso(left: string | null | undefined, right: string | null | undefined): string | null {
  const leftMs = toMs(left);
  const rightMs = toMs(right);
  if (leftMs === null && rightMs === null) return null;
  if (leftMs === null) return right ?? null;
  if (rightMs === null) return left ?? null;
  return leftMs >= rightMs ? (left ?? null) : (right ?? null);
}

function buildHotProviderSetIds(params: {
  allTargets: IngestTarget[];
  recentConsistencySetIds: string[];
  highValuePrioritySetIds: string[];
  coveragePrioritySetIds: string[];
}): string[] {
  const byProviderSetId = new Map(params.allTargets.map((target) => [target.providerSetId, target] as const));
  const output: string[] = [];
  const seen = new Set<string>();
  const add = (providerSetId: string | null | undefined) => {
    const trimmed = String(providerSetId ?? "").trim();
    if (!trimmed || seen.has(trimmed) || !byProviderSetId.has(trimmed)) return;
    seen.add(trimmed);
    output.push(trimmed);
  };

  for (const providerSetId of PINNED_HOT_SET_IDS) add(providerSetId);
  for (const providerSetId of params.recentConsistencySetIds) add(providerSetId);
  for (const providerSetId of params.highValuePrioritySetIds) add(providerSetId);
  for (const providerSetId of params.coveragePrioritySetIds) add(providerSetId);

  return output.slice(0, HOT_SET_LIMIT);
}

export function planScrydexTargetSelection(params: {
  availableTargets: IngestTarget[];
  failedSetQueue: string[];
  hotProviderSetIds: string[];
  setLimit: number;
  cursorSetCode: string | null;
  hotCursorProviderSetId: string | null;
  selectionPhase: number;
  hotSlotInterval?: number;
}): TargetSelectionPlan {
  const setLimit = Math.max(1, Math.floor(params.setLimit));
  const hotSlotInterval = Math.max(2, Math.floor(params.hotSlotInterval ?? HOT_SLOT_INTERVAL));
  const byProviderSetId = new Map(params.availableTargets.map((target) => [target.providerSetId, target] as const));
  const hotProviderSetIds = normalizeStringList(params.hotProviderSetIds).filter((providerSetId) => byProviderSetId.has(providerSetId));
  const hotTargetSet = new Set(hotProviderSetIds);
  const hotTargets = hotProviderSetIds.flatMap((providerSetId) => {
    const target = byProviderSetId.get(providerSetId);
    return target ? [target] : [];
  });
  const baselineTargets = params.availableTargets.filter((target) => !hotTargetSet.has(target.providerSetId));
  const fallbackBaselineTargets = baselineTargets.length > 0 ? baselineTargets : params.availableTargets;
  const baselineRing = rotateItemsFromCursor({
    items: fallbackBaselineTargets,
    limit: fallbackBaselineTargets.length || params.availableTargets.length,
    cursor: params.cursorSetCode,
    getKey: (target) => String(target.setCode ?? target.providerSetId),
  });
  const hotRing = rotateItemsFromCursor({
    items: hotTargets,
    limit: hotTargets.length,
    cursor: params.hotCursorProviderSetId,
    getKey: (target) => target.providerSetId,
  });

  const selectedTargets: IngestTarget[] = [];
  const seenProviderSetIds = new Set<string>();
  let baselineIndex = 0;
  let hotIndex = 0;
  let selectionPhase = Math.max(0, Math.floor(params.selectionPhase));
  let hotSlotCount = 0;
  let baselineSlotCount = 0;

  const takeNext = (ring: IngestTarget[], kind: "HOT" | "BASELINE"): IngestTarget | null => {
    let index = kind === "HOT" ? hotIndex : baselineIndex;
    while (index < ring.length) {
      const target = ring[index];
      index += 1;
      if (!target || seenProviderSetIds.has(target.providerSetId)) continue;
      if (kind === "HOT") hotIndex = index;
      else baselineIndex = index;
      return target;
    }
    if (kind === "HOT") hotIndex = index;
    else baselineIndex = index;
    return null;
  };

  const pushTarget = (target: IngestTarget) => {
    seenProviderSetIds.add(target.providerSetId);
    selectedTargets.push(target);
    if (hotTargetSet.has(target.providerSetId)) hotSlotCount += 1;
    else baselineSlotCount += 1;
    selectionPhase += 1;
  };

  for (const providerSetId of params.failedSetQueue) {
    if (selectedTargets.length >= setLimit) break;
    const target = byProviderSetId.get(providerSetId);
    if (!target || seenProviderSetIds.has(providerSetId)) continue;
    pushTarget(target);
  }

  while (selectedTargets.length < setLimit) {
    const wantsHotSlot = hotRing.length > 0 && ((selectionPhase + 1) % hotSlotInterval === 0);
    let target = wantsHotSlot ? takeNext(hotRing, "HOT") : takeNext(baselineRing, "BASELINE");
    if (!target) {
      target = wantsHotSlot ? takeNext(baselineRing, "BASELINE") : takeNext(hotRing, "HOT");
    }
    if (!target) break;
    pushTarget(target);
  }

  const nextSetCode = baselineIndex > 0
    ? String(baselineRing[Math.min(baselineIndex, baselineRing.length) - 1]?.setCode ?? "").trim() || params.cursorSetCode
    : params.cursorSetCode;
  const nextHotProviderSetId = hotIndex > 0
    ? hotRing[Math.min(hotIndex, hotRing.length) - 1]?.providerSetId ?? params.hotCursorProviderSetId
    : params.hotCursorProviderSetId;

  return {
    selectedTargets,
    nextSetCode,
    nextHotProviderSetId,
    nextSelectionPhase: selectionPhase,
    hotSlotCount,
    baselineSlotCount,
    hotProviderSetIds,
  };
}

async function loadProviderSetHealth(providerSetIds: string[]): Promise<Map<string, ProviderSetHealthRow>> {
  if (providerSetIds.length === 0) return new Map();
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_set_health")
    .select(
      "provider, provider_set_id, canonical_set_code, canonical_set_name, last_attempt_at, last_success_at, last_429_at, last_status_code, consecutive_429, cooldown_until, next_retry_at, last_error, requests_last_run, pages_last_run, cards_last_run, updated_at",
    )
    .eq("provider", PROVIDER)
    .in("provider_set_id", providerSetIds);
  if (error) throw new Error(`provider_set_health(load): ${error.message}`);

  const bySetId = new Map<string, ProviderSetHealthRow>();
  for (const row of (data ?? []) as ProviderSetHealthRow[]) {
    bySetId.set(row.provider_set_id, row);
  }
  return bySetId;
}

function extractScrydexHttpStatus(message: string | null | undefined): number | null {
  const match = String(message ?? "").match(/api error (\d{3})/i);
  if (!match) return null;
  const status = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(status) ? status : null;
}

async function loadCanonicalSetsFromPrintings(): Promise<CanonicalSet[]> {
  const supabase = dbAdmin();
  const pageSize = 1000;
  const seen = new Set<string>();
  const sets: CanonicalSet[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("set_code, set_name")
      .eq("language", "EN")
      .not("set_code", "is", null)
      .not("set_name", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`card_printings: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      const setCode = String(row.set_code ?? "");
      const setName = String(row.set_name ?? "");
      if (!isPhysicalPokemonSet({ setCode, setName })) continue;
      if (!setCode || !setName || seen.has(setCode)) continue;
      seen.add(setCode);
      sets.push({ setCode, setName });
    }

    if (rows.length < pageSize) break;
  }

  sets.sort((left, right) => left.setCode.localeCompare(right.setCode));
  return sets;
}

async function loadCanonicalSetsFromProviderIndex(): Promise<CanonicalSet[]> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code, canonical_set_name, provider_set_id")
    .eq("provider", PROVIDER)
    .not("provider_set_id", "is", null)
    .order("canonical_set_code", { ascending: true });

  if (error) throw new Error(`provider_set_map(scrydex index): ${error.message}`);

  const sets: CanonicalSet[] = [];
  for (const row of (data ?? []) as ProviderSetMapRow[]) {
    const setCode = String(row.canonical_set_code ?? "").trim();
    const providerSetId = String(row.provider_set_id ?? "").trim();
    if (!isPhysicalPokemonSet({ setCode, setName: row.canonical_set_name })) continue;
    if (!setCode || !providerSetId) continue;
    sets.push({
      setCode,
      setName: row.canonical_set_name?.trim() || setCode,
      providerSetId,
    });
  }

  return sets;
}

async function loadCanonicalSetsForScrydex(): Promise<CanonicalSet[]> {
  const [setsFromPrintings, setsFromProviderMap] = await Promise.all([
    loadCanonicalSetsFromPrintings(),
    loadCanonicalSetsFromProviderIndex(),
  ]);

  const bySetCode = new Map<string, CanonicalSet>();
  for (const set of setsFromPrintings) {
    bySetCode.set(set.setCode, {
      setCode: set.setCode,
      setName: set.setName,
      providerSetId: set.setCode,
    });
  }

  for (const set of setsFromProviderMap) {
    const existing = bySetCode.get(set.setCode);
    bySetCode.set(set.setCode, {
      setCode: set.setCode,
      setName: set.setName || existing?.setName || set.setCode,
      providerSetId: set.providerSetId ?? existing?.providerSetId ?? set.setCode,
    });
  }

  return [...bySetCode.values()].sort((left, right) => left.setCode.localeCompare(right.setCode));
}

async function maybeBackfillProviderSetMap(): Promise<number> {
  // Keep provider_set_map warm every run for faster mapping convergence.
  const supabase = dbAdmin();
  const [knownResult, canonicalSets] = await Promise.all([
    supabase
      .from("provider_set_map")
      .select("canonical_set_code")
      .eq("provider", PROVIDER),
    loadCanonicalSetsFromPrintings(),
  ]);
  if (knownResult.error) throw new Error(`provider_set_map(existing): ${knownResult.error.message}`);

  const knownSetCodes = new Set(
    (knownResult.data ?? [])
      .map((row) => String((row as { canonical_set_code: string | null }).canonical_set_code ?? "").trim())
      .filter(Boolean),
  );
  const missing = canonicalSets.filter((set) => !knownSetCodes.has(set.setCode)).slice(0, 250);
  if (missing.length === 0) return 0;

  const rows = missing.map((set) => ({
    provider: PROVIDER,
    canonical_set_code: set.setCode,
    canonical_set_name: set.setName,
    provider_set_id: set.setCode,
    confidence: 0,
  }));
  const { error } = await supabase
    .from("provider_set_map")
    .upsert(rows, { onConflict: "provider,canonical_set_code" });
  if (error) throw new Error(`provider_set_map(backfill): ${error.message}`);
  return rows.length;
}

async function insertRawPayloadRow(params: {
  providerSetId: string;
  page: number;
  body: unknown;
  statusCode: number;
  fetchedAt: string;
}) {
  const { providerSetId, page, body, statusCode, fetchedAt } = params;
  const supabase = dbAdmin();
  const payload = {
    provider: PROVIDER,
    endpoint: ENDPOINT,
    params: {
      expansionId: providerSetId,
      page,
      page_size: PAGE_LIMIT,
      include: "prices",
    },
    response: body ?? {},
    status_code: statusCode,
    fetched_at: fetchedAt,
    request_hash: requestHash(ENDPOINT, {
      expansionId: providerSetId,
      page,
      page_size: PAGE_LIMIT,
      include: "prices",
    }),
    response_hash: responseHash(body),
    canonical_slug: null,
    variant_ref: null,
  };

  const { error } = await supabase.from("provider_raw_payloads").insert(payload);
  if (!error) return { inserted: true, duplicate: false };
  if (isDuplicateInsertError(error.message)) return { inserted: false, duplicate: true };
  throw new Error(`provider_raw_payloads: ${error.message}`);
}

export async function runPokemonTcgRawIngest(opts: {
  setLimit?: number;
  providerSetId?: string | null;
  pageLimitPerSet?: number;
  maxRequests?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
  force?: boolean;
} = {}): Promise<RawIngestResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const setLimit = Math.min(
    parsePositiveInt(opts.setLimit, DEFAULT_SETS_PER_RUN),
    Math.max(1, MAX_SETS_PER_RUN_CAP),
  );
  const pageLimitPerSet = Math.min(
    parsePositiveInt(opts.pageLimitPerSet, 100),
    Math.max(1, MAX_PAGE_LIMIT_PER_SET_CAP),
  );
  const maxRequests = Math.min(
    parsePositiveInt(opts.maxRequests, DEFAULT_MAX_REQUESTS),
    Math.max(1, MAX_REQUESTS_PER_RUN_CAP),
  );
  const retryAttempts = parsePositiveInt(opts.retryAttempts, DEFAULT_RETRY_ATTEMPTS);
  const retryBackoffMs = parsePositiveInt(opts.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
  const cooldownMinutes = parsePositiveInt(DEFAULT_COOLDOWN_MINUTES, 180);
  const cooldownMs = cooldownMinutes * 60 * 1000;

  let firstError: string | null = null;
  let requestsMade = 0;
  let rawPayloadsInserted = 0;
  let rawPayloadsDuplicate = 0;
  let cardsFetched = 0;
  let failedRequests = 0;
  let setsProcessed = 0;
  let skippedCooldownSets = 0;
  let providerSetIndexBackfilled = 0;
  const sampleSetResults: RawIngestSetSummary[] = [];
  const warningSamples: string[] = [];
  const skippedCooldownSamples: string[] = [];
  const nowMs = Date.now();
  const providerCooldownState = await getProviderCooldownState(PROVIDER);
  const providerCooldownActive = providerCooldownState.active && opts.force !== true;
  let providerCooldownUntil = providerCooldownState.cooldownUntil;
  let providerCooldownError = providerCooldownState.lastError;
  let providerCooldownTriggered = providerCooldownActive;

  let credentials: ReturnType<typeof getScrydexCredentials>;
  try {
    credentials = getScrydexCredentials();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const priorState = opts.providerSetId
    ? {
        cursorSetCode: null,
        hotCursorProviderSetId: null,
        selectionPhase: 0,
        failedSetQueue: [] as string[],
        cooldownByProviderSet: {} as Record<string, string>,
      }
    : await loadLastRunState();
  let failedSetQueue = normalizeFailedSetQueue(priorState.failedSetQueue);
  let cooldownByProviderSet = pruneCooldowns(priorState.cooldownByProviderSet, nowMs);

  const targets = opts.providerSetId
    ? {
        selectedTargets: [{ setCode: null, setName: null, providerSetId: opts.providerSetId }],
        nextSetCode: null as string | null,
        nextHotProviderSetId: null as string | null,
        nextSelectionPhase: priorState.selectionPhase,
        hotProviderSetIds: [] as string[],
        hotSlotCount: 0,
        baselineSlotCount: 0,
      }
    : providerCooldownActive
      ? {
          selectedTargets: [] as IngestTarget[],
          nextSetCode: priorState.cursorSetCode,
          nextHotProviderSetId: priorState.hotCursorProviderSetId,
          nextSelectionPhase: priorState.selectionPhase,
          hotProviderSetIds: [] as string[],
          hotSlotCount: 0,
          baselineSlotCount: 0,
        }
    : await (async () => {
        providerSetIndexBackfilled = await maybeBackfillProviderSetMap();
        const sets = await loadCanonicalSetsForScrydex();
        const allTargets: IngestTarget[] = sets.map((set) => ({
          setCode: set.setCode,
          setName: set.setName,
          providerSetId: set.providerSetId ?? set.setCode,
        }));
        const healthByProviderSet = await loadProviderSetHealth(allTargets.map((target) => target.providerSetId));
        const retryFromHealth = allTargets
          .map((target) => ({
            providerSetId: target.providerSetId,
            health: healthByProviderSet.get(target.providerSetId),
          }))
          .filter((row) => (row.health?.consecutive_429 ?? 0) > 0)
          .filter((row) => {
            const nextRetryMs = toMs(row.health?.next_retry_at ?? null);
            return nextRetryMs === null || nextRetryMs <= nowMs;
          })
          .map((row) => row.providerSetId);
        failedSetQueue = normalizeFailedSetQueue([...retryFromHealth, ...failedSetQueue]);
        for (const target of allTargets) {
          const health = healthByProviderSet.get(target.providerSetId);
          if (!health?.cooldown_until) continue;
          const merged = maxIso(cooldownByProviderSet[target.providerSetId] ?? null, health.cooldown_until);
          if (merged) cooldownByProviderSet[target.providerSetId] = merged;
        }
        const [recentConsistencySetIds, highValuePrioritySetIds, coveragePrioritySetIds] = await Promise.all([
          loadRecentSetConsistencyPriority({
            provider: "SCRYDEX",
            targets: allTargets,
            yearFrom: 2024,
            freshWindowHours: 24,
            maxProviderSetIds: 300,
          }),
          loadHighValueStaleSetPriority({
            provider: "SCRYDEX",
            targets: allTargets,
            staleWindowHours: 24,
            maxProviderSetIds: 300,
          }),
          loadCoverageGapSetPriority({
            provider: "SCRYDEX",
            targets: allTargets,
            maxProviderSetIds: 300,
          }),
        ]);
        const hotProviderSetIds = buildHotProviderSetIds({
          allTargets,
          recentConsistencySetIds,
          highValuePrioritySetIds,
          coveragePrioritySetIds,
        });
        const availableTargets: IngestTarget[] = [];
        for (const target of allTargets) {
          const cooldown = isSetInCooldown({
            providerSetId: target.providerSetId,
            cooldownByProviderSet,
            nowMs,
          });
          if (cooldown.active) {
            skippedCooldownSets += 1;
            if (skippedCooldownSamples.length < 25) {
              skippedCooldownSamples.push(`set=${target.providerSetId} until=${cooldown.untilIso ?? "unknown"}`);
            }
            continue;
          }
          availableTargets.push(target);
        }

        return planScrydexTargetSelection({
          availableTargets,
          failedSetQueue,
          hotProviderSetIds,
          setLimit,
          cursorSetCode: priorState.cursorSetCode,
          hotCursorProviderSetId: priorState.hotCursorProviderSetId,
          selectionPhase: priorState.selectionPhase,
          hotSlotInterval: HOT_SLOT_INTERVAL,
        });
      })();
  const resolvedTargets = Array.isArray(targets) ? targets : targets.selectedTargets;
  const nextSetCode = Array.isArray(targets) ? null : targets.nextSetCode;
  const nextHotProviderSetId = Array.isArray(targets) ? null : targets.nextHotProviderSetId;
  const nextSelectionPhase = Array.isArray(targets) ? priorState.selectionPhase : targets.nextSelectionPhase;
  const hotProviderSetIds = Array.isArray(targets) ? [] : targets.hotProviderSetIds;
  const hotSlotCount = Array.isArray(targets) ? 0 : targets.hotSlotCount;
  const baselineSlotCount = Array.isArray(targets) ? 0 : targets.baselineSlotCount;
  const cursorSetCode = priorState.cursorSetCode;
  const hotCursorProviderSetId = priorState.hotCursorProviderSetId;
  const selectionPhase = priorState.selectionPhase;
  const providerSetHealthBySet = await loadProviderSetHealth(
    resolvedTargets.map((target) => target.providerSetId),
  );
  const providerSetHealthUpserts: ProviderSetHealthUpsertRow[] = [];
  const providerSetMapUpserts: Array<{
    provider: string;
    canonical_set_code: string;
    canonical_set_name: string;
    provider_set_id: string;
    confidence: number;
    last_verified_at: string;
  }> = [];

  if (providerCooldownActive && warningSamples.length < 25) {
    warningSamples.push(
      `provider cooldown active until=${providerCooldownUntil ?? "unknown"} reason=${providerCooldownError ?? "credit cap"}`,
    );
  }

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
        mode: "raw-only",
        pageLimit: PAGE_LIMIT,
        pageLimitPerSet,
        maxRequests,
        retryAttempts,
        retryBackoffMs,
        providerSetId: opts.providerSetId ?? null,
        cursorSetCode,
        nextSetCode,
        hotCursorProviderSetId,
        nextHotProviderSetId,
        selectionPhase,
        nextSelectionPhase,
        hotSlotInterval: HOT_SLOT_INTERVAL,
        hotProviderSetIds,
        hotSlotCount,
        baselineSlotCount,
        providerSetIndexBackfilled,
        setsPlanned: resolvedTargets.length,
        skippedCooldownSets,
        skippedCooldownSamples,
        failedSetQueue,
      },
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (runStartError) {
    throw new Error(`ingest_runs(start): ${runStartError.message}`);
  }

  const runId = runRow?.id ?? null;

  for (const target of resolvedTargets) {
    if (providerCooldownTriggered) break;
    if (requestsMade >= maxRequests) break;
    setsProcessed += 1;

    let pagesFetched = 0;
    let cardsFetchedForSet = 0;
    let page = 1;
    let hasMore = false;
    let lastStatus: number | null = null;
    let requestAttemptsForSet = 0;
    let setLastError: string | null = null;
    let setHadSuccess = false;
    let setHadRetryableFailure = false;
    let duplicatePagesForSet = 0;

    while (requestsMade < maxRequests && pagesFetched < pageLimitPerSet) {
      let pageSucceeded = false;
      for (let attempt = 1; attempt <= retryAttempts && requestsMade < maxRequests; attempt += 1) {
        const fetchedAt = new Date().toISOString();
        requestsMade += 1;
        requestAttemptsForSet += 1;
        try {
          const payload = await fetchCardsPage(page, PAGE_LIMIT, target.providerSetId, credentials);
          const cards = payload.data ?? [];
          const rawEnvelope: { data: ScrydexCard[] } = { data: cards };

          const rawInsert = await insertRawPayloadRow({
            providerSetId: target.providerSetId,
            page,
            body: rawEnvelope,
            statusCode: 200,
            fetchedAt,
          });
          if (rawInsert.inserted) rawPayloadsInserted += 1;
          if (rawInsert.duplicate) {
            rawPayloadsDuplicate += 1;
            duplicatePagesForSet += 1;
          }

          pagesFetched += 1;
          lastStatus = 200;
          cardsFetched += cards.length;
          cardsFetchedForSet += cards.length;
          setHadSuccess = true;

          hasMore = cards.length >= PAGE_LIMIT && (typeof payload.totalCount !== "number" || (page * PAGE_LIMIT) < payload.totalCount);
          if (!hasMore || cards.length === 0) {
            pageSucceeded = true;
            break;
          }

          page += 1;
          pageSucceeded = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const statusCode = extractScrydexHttpStatus(message);
          const creditCapHit = isProviderCreditCapError(PROVIDER, message);
          if (statusCode !== null) {
            lastStatus = statusCode;
          } else if (lastStatus === null && isRetryableScrydexError(message)) {
            lastStatus = 522;
          }
          const shouldCooldown = creditCapHit || statusCode === 429 || (typeof statusCode === "number" && statusCode >= 500);
          if (shouldCooldown) setHadRetryableFailure = true;
          setLastError = message;
          const canRetry = !creditCapHit
            && attempt < retryAttempts
            && (shouldCooldown || isRetryableScrydexError(message))
            && requestsMade < maxRequests;
          if (canRetry) {
            await delayMs(retryBackoffMs * attempt);
            continue;
          }
          failedRequests += 1;
          if (creditCapHit) {
            providerCooldownTriggered = true;
            providerCooldownError = message;
            providerCooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
          }
          if (shouldCooldown) {
            cooldownByProviderSet[target.providerSetId] = providerCooldownUntil ?? new Date(Date.now() + cooldownMs).toISOString();
          }
          if (!creditCapHit) firstError ??= message;
          if (warningSamples.length < 25) {
            warningSamples.push(
              `set=${target.providerSetId} page=${page} status=${lastStatus ?? "error"} attempts=${attempt}`,
            );
          }
          hasMore = false;
          pageSucceeded = false;
          break;
        }
      }
      if (!pageSucceeded) break;
    }

    if (setHadRetryableFailure) {
      failedSetQueue = normalizeFailedSetQueue([...failedSetQueue, target.providerSetId]);
    }
    if (setHadSuccess) {
      failedSetQueue = failedSetQueue.filter((providerSetId) => providerSetId !== target.providerSetId);
      delete cooldownByProviderSet[target.providerSetId];
    }

    // If any page for this set was a response-hash dedup (identical data as
    // last fetch), the normal ingest → normalize → match → timeseries flow
    // short-circuits and nothing advances market_price_as_of. Call the
    // touch_verified_snapshots RPC to advance observed_at on the latest
    // snapshot per (slug, variant_ref, grade) AND queue variant keys to
    // pending_rollups so the drain propagates the fresh timestamp to
    // public_card_metrics. Non-fatal on error.
    if (setHadSuccess && duplicatePagesForSet > 0) {
      try {
        await dbAdmin().rpc("touch_verified_snapshots", {
          p_provider: PROVIDER,
          p_provider_set_id: target.providerSetId,
        });
      } catch (touchError) {
        const message = touchError instanceof Error ? touchError.message : String(touchError);
        console.warn(
          `[scrydex-raw-ingest] touch_verified_snapshots failed for ${target.providerSetId}: ${message}`,
        );
      }
    }

    if (sampleSetResults.length < 25) {
      sampleSetResults.push({
        canonicalSetCode: target.setCode,
        canonicalSetName: target.setName,
        providerSetId: target.providerSetId,
        pagesFetched,
        cardsFetched: cardsFetchedForSet,
        lastStatus,
        hasMore,
      });
    }

    const previousHealth = providerSetHealthBySet.get(target.providerSetId);
    const nowIso = new Date().toISOString();
    const consecutive429 = lastStatus === 429
      ? (Math.max(0, previousHealth?.consecutive_429 ?? 0) + 1)
      : 0;
    const cooldownUntil = cooldownByProviderSet[target.providerSetId] ?? null;
    const healthRow: ProviderSetHealthUpsertRow = {
      provider: PROVIDER,
      provider_set_id: target.providerSetId,
      canonical_set_code: target.setCode,
      canonical_set_name: target.setName,
      last_attempt_at: nowIso,
      last_success_at: setHadSuccess ? nowIso : (previousHealth?.last_success_at ?? null),
      last_429_at: lastStatus === 429 ? nowIso : (previousHealth?.last_429_at ?? null),
      last_status_code: lastStatus,
      consecutive_429: consecutive429,
      cooldown_until: cooldownUntil,
      next_retry_at: cooldownUntil,
      last_error: setLastError,
      requests_last_run: requestAttemptsForSet,
      pages_last_run: pagesFetched,
      cards_last_run: cardsFetchedForSet,
      updated_at: nowIso,
    };
    providerSetHealthUpserts.push(healthRow);
    providerSetHealthBySet.set(target.providerSetId, {
      provider: PROVIDER,
      provider_set_id: target.providerSetId,
      canonical_set_code: target.setCode,
      canonical_set_name: target.setName,
      last_attempt_at: healthRow.last_attempt_at,
      last_success_at: healthRow.last_success_at,
      last_429_at: healthRow.last_429_at,
      last_status_code: healthRow.last_status_code,
      consecutive_429: healthRow.consecutive_429,
      cooldown_until: healthRow.cooldown_until,
      next_retry_at: healthRow.next_retry_at,
      last_error: healthRow.last_error,
      requests_last_run: healthRow.requests_last_run,
      pages_last_run: healthRow.pages_last_run,
      cards_last_run: healthRow.cards_last_run,
      updated_at: healthRow.updated_at,
    });

    if (setHadSuccess && cardsFetchedForSet > 0 && target.setCode) {
      providerSetMapUpserts.push({
        provider: PROVIDER,
        canonical_set_code: target.setCode,
        canonical_set_name: target.setName ?? target.setCode,
        provider_set_id: target.providerSetId,
        confidence: 1,
        last_verified_at: nowIso,
      });
    }
  }

  cooldownByProviderSet = pruneCooldowns(cooldownByProviderSet, Date.now());

  if (providerCooldownTriggered && providerCooldownUntil && providerCooldownError) {
    await markProviderCreditCapCooldown({
      provider: PROVIDER,
      statusCode: 403,
      errorMessage: providerCooldownError,
      canonicalSetCode: PROVIDER,
      canonicalSetName: "SCRYDEX provider cooldown",
    });
  }

  if (providerSetHealthUpserts.length > 0) {
    const dedupedByProviderSet = new Map<string, ProviderSetHealthUpsertRow>();
    for (const row of providerSetHealthUpserts) {
      dedupedByProviderSet.set(row.provider_set_id, row);
    }
    const { error: healthUpsertError } = await supabase
      .from("provider_set_health")
      .upsert([...dedupedByProviderSet.values()], { onConflict: "provider,provider_set_id" });
    if (healthUpsertError) {
      firstError ??= `provider_set_health(upsert): ${healthUpsertError.message}`;
    }
  }

  if (providerSetMapUpserts.length > 0) {
    const dedupedBySetCode = new Map<string, typeof providerSetMapUpserts[number]>();
    for (const row of providerSetMapUpserts) {
      dedupedBySetCode.set(row.canonical_set_code, row);
    }
    const { error: providerSetMapError } = await supabase
      .from("provider_set_map")
      .upsert([...dedupedBySetCode.values()], { onConflict: "provider,canonical_set_code" });
    if (providerSetMapError) {
      firstError ??= `provider_set_map(verify): ${providerSetMapError.message}`;
    }
  }

  const endedAt = new Date().toISOString();
  const result: RawIngestResult = {
    ok: firstError === null,
    job: JOB,
    provider: PROVIDER,
    startedAt,
    endedAt,
    setsPlanned: resolvedTargets.length,
    setsProcessed,
    selectedProviderSetIds: resolvedTargets.map((target) => target.providerSetId),
    requestsMade,
    rawPayloadsInserted,
    rawPayloadsDuplicate,
    cardsFetched,
    failedRequests,
    pageLimit: PAGE_LIMIT,
    sampleSetResults,
    warningCount: failedRequests,
    warningSamples,
    skippedCooldownSets,
    skippedCooldownSamples,
    firstError,
  };

  if (runId) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: result.ok,
        items_fetched: cardsFetched,
        items_upserted: rawPayloadsInserted,
        items_failed: failedRequests,
        ended_at: endedAt,
        meta: {
          mode: "raw-only",
          pageLimit: PAGE_LIMIT,
          pageLimitPerSet,
          maxRequests,
          retryAttempts,
          retryBackoffMs,
          providerSetId: opts.providerSetId ?? null,
          cursorSetCode,
          nextSetCode,
          hotCursorProviderSetId,
          nextHotProviderSetId,
          selectionPhase,
          nextSelectionPhase,
          hotSlotInterval: HOT_SLOT_INTERVAL,
          hotProviderSetIds,
          hotSlotCount,
          baselineSlotCount,
          providerSetIndexBackfilled,
          setsPlanned: resolvedTargets.length,
          setsProcessed,
          selectedProviderSetIds: resolvedTargets.map((target) => target.providerSetId),
          requestsMade,
          rawPayloadsInserted,
          rawPayloadsDuplicate,
          sampleSetResults,
          warningCount: failedRequests,
          warningSamples,
          skippedCooldownSets,
          skippedCooldownSamples,
          failedSetQueue,
          cooldownByProviderSet,
          providerSetHealthRowsWritten: providerSetHealthUpserts.length,
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}

export async function runScrydexRawIngest(opts: {
  setLimit?: number;
  providerSetId?: string | null;
  pageLimitPerSet?: number;
  maxRequests?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
  force?: boolean;
} = {}): Promise<RawIngestResult> {
  return runPokemonTcgRawIngest(opts);
}
