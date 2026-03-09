import crypto from "node:crypto";
import { dbAdmin } from "@/lib/db/admin";
import { buildSetId } from "@/lib/sets/summary-core.mjs";
import {
  fetchPokeTraceCardsPage,
  fetchPokeTraceSetsPage,
  getPokeTraceCredentials,
  type PokeTraceCard,
  type PokeTraceSet,
} from "@/lib/poketrace/client";

const PROVIDER = "POKETRACE";
const JOB = "poketrace_raw_ingest";
const ENDPOINT = "/cards";
const PAGE_LIMIT = 20;
const DEFAULT_SETS_PER_RUN = process.env.POKETRACE_RAW_SETS_PER_RUN
  ? parseInt(process.env.POKETRACE_RAW_SETS_PER_RUN, 10)
  : 4;
const DEFAULT_MAX_REQUESTS = process.env.POKETRACE_RAW_MAX_REQUESTS
  ? parseInt(process.env.POKETRACE_RAW_MAX_REQUESTS, 10)
  : 8;
const DEFAULT_RETRY_ATTEMPTS = process.env.POKETRACE_RAW_RETRY_ATTEMPTS
  ? parseInt(process.env.POKETRACE_RAW_RETRY_ATTEMPTS, 10)
  : 2;
const DEFAULT_RETRY_BACKOFF_MS = process.env.POKETRACE_RAW_RETRY_BACKOFF_MS
  ? parseInt(process.env.POKETRACE_RAW_RETRY_BACKOFF_MS, 10)
  : 2500;
const DEFAULT_REQUEST_DELAY_MS = process.env.POKETRACE_RAW_REQUEST_DELAY_MS
  ? parseInt(process.env.POKETRACE_RAW_REQUEST_DELAY_MS, 10)
  : 2100;
const DEFAULT_COOLDOWN_MINUTES = process.env.POKETRACE_RAW_COOLDOWN_MINUTES
  ? parseInt(process.env.POKETRACE_RAW_COOLDOWN_MINUTES, 10)
  : 180;
const DEFAULT_FAILED_QUEUE_LIMIT = process.env.POKETRACE_FAILED_SET_QUEUE_LIMIT
  ? parseInt(process.env.POKETRACE_FAILED_SET_QUEUE_LIMIT, 10)
  : 200;
const MAX_SETS_PER_RUN_CAP = process.env.POKETRACE_RAW_SETS_PER_RUN_CAP
  ? parseInt(process.env.POKETRACE_RAW_SETS_PER_RUN_CAP, 10)
  : 4;
const MAX_REQUESTS_PER_RUN_CAP = process.env.POKETRACE_RAW_MAX_REQUESTS_CAP
  ? parseInt(process.env.POKETRACE_RAW_MAX_REQUESTS_CAP, 10)
  : 12;
const SET_LOOKUP_PAGE_LIMIT = process.env.POKETRACE_SET_LOOKUP_PAGE_LIMIT
  ? Math.max(1, Math.min(100, parseInt(process.env.POKETRACE_SET_LOOKUP_PAGE_LIMIT, 10)))
  : 100;
const DEFAULT_SET_LOOKUP_MAX_REQUESTS = process.env.POKETRACE_SET_LOOKUP_MAX_REQUESTS
  ? Math.max(0, parseInt(process.env.POKETRACE_SET_LOOKUP_MAX_REQUESTS, 10))
  : 2;
const SET_LOOKUP_STOP_WORDS = new Set([
  "and",
  "expansion",
  "pokemon",
  "series",
  "set",
  "tcg",
]);

type CanonicalSet = {
  setCode: string;
  setName: string;
  providerSetId?: string | null;
  mapConfidence: number;
};

type ProviderSetMapRow = {
  canonical_set_code: string;
  canonical_set_name: string | null;
  provider_set_id: string;
  confidence: number | null;
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
  mapConfidence: number;
};

type IngestRunState = {
  cursorSetCode: string | null;
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
  liveSetLookupRequests: number;
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

type LiveSetResolutionCandidate = {
  providerSetId: string;
  providerSetName: string | null;
  score: number;
  matchedBy: string;
};

type LiveSetResolutionState = {
  best: LiveSetResolutionCandidate | null;
  second: LiveSetResolutionCandidate | null;
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
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

function isRetryablePokeTraceError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes(" 429")
    || text.includes("timed out")
    || text.includes("timeout")
    || text.includes("fetch failed")
    || text.includes("network")
    || text.includes("socket")
    || text.includes("econnreset")
    || text.includes("etimedout")
    || text.includes("eai_again");
}

function normalizeProviderSetSlugFromCanonical(setName: string): string {
  const slug = buildSetId(setName);
  return String(slug ?? "").trim();
}

function normalizeSetLookupText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSetLookupTokenKey(value: string | null | undefined): string {
  const normalized = normalizeSetLookupText(value);
  if (!normalized) return "";
  return normalized
    .split(" ")
    .filter((token) => token && !SET_LOOKUP_STOP_WORDS.has(token))
    .join(" ");
}

function scoreLiveSetResolutionCandidate(
  target: IngestTarget,
  liveSet: PokeTraceSet,
): LiveSetResolutionCandidate | null {
  const liveSlug = String(liveSet.slug ?? "").trim();
  if (!liveSlug || !target.setName) return null;

  const liveName = String(liveSet.name ?? "").trim();
  const targetName = String(target.setName ?? "").trim();
  const targetCanonicalSlug = normalizeProviderSetSlugFromCanonical(targetName);
  const targetExactKey = normalizeSetLookupText(targetName);
  const targetTokenKey = normalizeSetLookupTokenKey(targetName);
  const liveExactKey = normalizeSetLookupText(liveName);
  const liveTokenKey = normalizeSetLookupTokenKey(liveName);
  const liveSlugTokenKey = normalizeSetLookupTokenKey(liveSlug);

  if (
    target.providerSetId
    && liveSlug === target.providerSetId
    && (
      (targetExactKey && liveExactKey && targetExactKey === liveExactKey)
      || (targetTokenKey && liveTokenKey && targetTokenKey === liveTokenKey)
    )
  ) {
    return {
      providerSetId: liveSlug,
      providerSetName: liveName || null,
      score: 100,
      matchedBy: "existing_slug",
    };
  }

  if (targetExactKey && liveExactKey && targetExactKey === liveExactKey) {
    return {
      providerSetId: liveSlug,
      providerSetName: liveName || null,
      score: 99,
      matchedBy: "name_exact",
    };
  }

  if (targetTokenKey && liveTokenKey && targetTokenKey === liveTokenKey) {
    return {
      providerSetId: liveSlug,
      providerSetName: liveName || null,
      score: 97,
      matchedBy: "name_token_exact",
    };
  }

  if (targetCanonicalSlug && liveSlug === targetCanonicalSlug) {
    return {
      providerSetId: liveSlug,
      providerSetName: liveName || null,
      score: 96,
      matchedBy: "canonical_slug",
    };
  }

  if (targetTokenKey && liveSlugTokenKey && targetTokenKey === liveSlugTokenKey) {
    return {
      providerSetId: liveSlug,
      providerSetName: liveName || null,
      score: 95,
      matchedBy: "slug_token_exact",
    };
  }

  return null;
}

function updateLiveSetResolutionState(
  state: LiveSetResolutionState,
  candidate: LiveSetResolutionCandidate,
): LiveSetResolutionState {
  if (!state.best) {
    return { best: candidate, second: state.second };
  }
  if (candidate.providerSetId === state.best.providerSetId) {
    if (candidate.score > state.best.score) {
      return { best: candidate, second: state.second };
    }
    return state;
  }
  if (candidate.score > state.best.score) {
    return { best: candidate, second: state.best };
  }
  if (!state.second || candidate.score > state.second.score) {
    return { best: state.best, second: candidate };
  }
  return state;
}

function acceptLiveSetResolutionCandidate(
  state: LiveSetResolutionState | undefined,
): LiveSetResolutionCandidate | null {
  if (!state?.best || state.best.score < 96) return null;
  if (state.second && state.second.score >= state.best.score) return null;
  return state.best;
}

async function resolveTargetsFromLiveSetIndex(params: {
  targets: IngestTarget[];
  credentials: ReturnType<typeof getPokeTraceCredentials>;
  maxRequests: number;
}): Promise<{
  requestsMade: number;
  targets: IngestTarget[];
  warningSamples: string[];
}> {
  const unresolved = params.targets.filter((target) => (
    Boolean(target.setCode)
    && Boolean(target.setName)
    && target.mapConfidence <= 0
  ));
  if (unresolved.length === 0 || params.maxRequests <= 0) {
    return { requestsMade: 0, targets: params.targets, warningSamples: [] };
  }

  const resolutionBySetCode = new Map<string, LiveSetResolutionState>();
  for (const target of unresolved) {
    if (!target.setCode) continue;
    resolutionBySetCode.set(target.setCode, { best: null, second: null });
  }

  let requestsMade = 0;
  let cursor: string | null = null;
  while (requestsMade < params.maxRequests) {
    const payload = await fetchPokeTraceSetsPage({
      cursor,
      limit: SET_LOOKUP_PAGE_LIMIT,
      credentials: params.credentials,
    });
    requestsMade += 1;

    for (const liveSet of payload.data ?? []) {
      for (const target of unresolved) {
        if (!target.setCode) continue;
        const candidate = scoreLiveSetResolutionCandidate(target, liveSet);
        if (!candidate) continue;
        const current = resolutionBySetCode.get(target.setCode) ?? { best: null, second: null };
        resolutionBySetCode.set(target.setCode, updateLiveSetResolutionState(current, candidate));
      }
    }

    cursor = String(payload.pagination?.nextCursor ?? payload.nextCursor ?? "").trim() || null;
    if (!cursor) break;
  }

  const warningSamples: string[] = [];
  const targets = params.targets.map((target) => {
    if (!target.setCode || target.mapConfidence > 0) return target;
    const candidate = acceptLiveSetResolutionCandidate(resolutionBySetCode.get(target.setCode));
    if (!candidate) return target;
    if (warningSamples.length < 25 && candidate.providerSetId !== target.providerSetId) {
      warningSamples.push(
        `resolved live set map ${target.setCode}: ${target.providerSetId} -> ${candidate.providerSetId} via ${candidate.matchedBy}`,
      );
    }
    return {
      ...target,
      providerSetId: candidate.providerSetId,
    };
  });

  return { requestsMade, targets, warningSamples };
}

function selectSetsFromCursor(sets: CanonicalSet[], setLimit: number, cursorSetCode: string | null): CanonicalSet[] {
  if (sets.length === 0) return [];
  const limit = Math.min(Math.max(1, setLimit), sets.length);
  if (!cursorSetCode) return sets.slice(0, limit);

  const cursorIndex = sets.findIndex((row) => row.setCode === cursorSetCode);
  const startIndex = cursorIndex >= 0 ? (cursorIndex + 1) % sets.length : 0;
  const selected: CanonicalSet[] = [];
  for (let i = 0; i < limit; i += 1) {
    selected.push(sets[(startIndex + i) % sets.length]);
  }
  return selected;
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
    .limit(1)
    .maybeSingle<LastRunRow>();

  if (error) throw new Error(`ingest_runs(last state): ${error.message}`);

  const meta = data?.meta ?? {};
  const cursorRaw = typeof meta.nextSetCode === "string"
    ? meta.nextSetCode
    : (typeof meta.cursorSetCode === "string" ? meta.cursorSetCode : "");
  return {
    cursorSetCode: cursorRaw.trim() || null,
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

function sortTargetsByFreshness(
  targets: IngestTarget[],
  healthByProviderSet: Map<string, ProviderSetHealthRow>,
): IngestTarget[] {
  return [...targets].sort((a, b) => {
    const ah = healthByProviderSet.get(a.providerSetId);
    const bh = healthByProviderSet.get(b.providerSetId);
    const aSuccess = toMs(ah?.last_success_at) ?? 0;
    const bSuccess = toMs(bh?.last_success_at) ?? 0;
    if (aSuccess !== bSuccess) return aSuccess - bSuccess;
    const aAttempt = toMs(ah?.last_attempt_at) ?? 0;
    const bAttempt = toMs(bh?.last_attempt_at) ?? 0;
    if (aAttempt !== bAttempt) return aAttempt - bAttempt;
    return String(a.setCode ?? "").localeCompare(String(b.setCode ?? ""));
  });
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

function extractPokeTraceHttpStatus(message: string | null | undefined): number | null {
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
      const providerSetId = normalizeProviderSetSlugFromCanonical(setName);
      if (!setCode || !setName || !providerSetId || seen.has(setCode)) continue;
      seen.add(setCode);
      sets.push({ setCode, setName, providerSetId, mapConfidence: 0 });
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
    .select("canonical_set_code, canonical_set_name, provider_set_id, confidence")
    .eq("provider", PROVIDER)
    .not("provider_set_id", "is", null)
    .order("canonical_set_code", { ascending: true });

  if (error) throw new Error(`provider_set_map(poketrace index): ${error.message}`);

  const sets: CanonicalSet[] = [];
  for (const row of (data ?? []) as ProviderSetMapRow[]) {
    const setCode = String(row.canonical_set_code ?? "").trim();
    const providerSetId = String(row.provider_set_id ?? "").trim();
    if (!setCode || !providerSetId) continue;
    sets.push({
      setCode,
      setName: row.canonical_set_name?.trim() || setCode,
      providerSetId,
      mapConfidence: typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? row.confidence
        : 0,
    });
  }

  return sets;
}

async function loadCanonicalSetsForPokeTrace(): Promise<CanonicalSet[]> {
  const [setsFromPrintings, setsFromProviderMap] = await Promise.all([
    loadCanonicalSetsFromPrintings(),
    loadCanonicalSetsFromProviderIndex(),
  ]);

  const bySetCode = new Map<string, CanonicalSet>();
  for (const set of setsFromPrintings) {
    bySetCode.set(set.setCode, {
      setCode: set.setCode,
      setName: set.setName,
      providerSetId: set.providerSetId,
      mapConfidence: set.mapConfidence,
    });
  }

  for (const set of setsFromProviderMap) {
    const existing = bySetCode.get(set.setCode);
    const shouldReplace = !existing || set.mapConfidence >= existing.mapConfidence;
    bySetCode.set(set.setCode, {
      setCode: set.setCode,
      setName: set.setName || existing?.setName || set.setCode,
      providerSetId: shouldReplace
        ? (set.providerSetId ?? existing?.providerSetId)
        : existing?.providerSetId,
      mapConfidence: shouldReplace
        ? set.mapConfidence
        : (existing?.mapConfidence ?? 0),
    });
  }

  return [...bySetCode.values()]
    .filter((set) => Boolean(set.providerSetId))
    .sort((left, right) => left.setCode.localeCompare(right.setCode));
}

async function maybeBackfillProviderSetMap(): Promise<number> {
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
    provider_set_id: set.providerSetId,
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
  cursor: string | null;
  body: unknown;
  statusCode: number;
  fetchedAt: string;
}) {
  const { providerSetId, cursor, body, statusCode, fetchedAt } = params;
  const supabase = dbAdmin();
  const payload = {
    provider: PROVIDER,
    endpoint: ENDPOINT,
    params: {
      set: providerSetId,
      cursor,
      limit: PAGE_LIMIT,
      market: "US",
    },
    response: body ?? {},
    status_code: statusCode,
    fetched_at: fetchedAt,
    request_hash: requestHash(ENDPOINT, {
      set: providerSetId,
      cursor,
      limit: PAGE_LIMIT,
      market: "US",
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

export async function runPokeTraceRawIngest(opts: {
  setLimit?: number;
  providerSetId?: string | null;
  pageLimitPerSet?: number;
  maxRequests?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
} = {}): Promise<RawIngestResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const setLimit = Math.min(
    parsePositiveInt(opts.setLimit, DEFAULT_SETS_PER_RUN),
    Math.max(1, MAX_SETS_PER_RUN_CAP),
  );
  const pageLimitPerSet = parsePositiveInt(opts.pageLimitPerSet, 50);
  const maxRequests = Math.min(
    parsePositiveInt(opts.maxRequests, DEFAULT_MAX_REQUESTS),
    Math.max(1, MAX_REQUESTS_PER_RUN_CAP),
  );
  const retryAttempts = parsePositiveInt(opts.retryAttempts, DEFAULT_RETRY_ATTEMPTS);
  const retryBackoffMs = parsePositiveInt(opts.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
  const requestDelayMs = parsePositiveInt(DEFAULT_REQUEST_DELAY_MS, 2100);
  const cooldownMinutes = parsePositiveInt(DEFAULT_COOLDOWN_MINUTES, 180);
  const cooldownMs = cooldownMinutes * 60 * 1000;

  let firstError: string | null = null;
  let requestsMade = 0;
  let liveSetLookupRequests = 0;
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

  let credentials: ReturnType<typeof getPokeTraceCredentials>;
  try {
    credentials = getPokeTraceCredentials();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const priorState = opts.providerSetId
    ? { cursorSetCode: null, failedSetQueue: [] as string[], cooldownByProviderSet: {} as Record<string, string> }
    : await loadLastRunState();
  let failedSetQueue = normalizeFailedSetQueue(priorState.failedSetQueue);
  let cooldownByProviderSet = pruneCooldowns(priorState.cooldownByProviderSet, nowMs);

  const targets = opts.providerSetId
    ? {
        selectedTargets: [{ setCode: null, setName: null, providerSetId: opts.providerSetId, mapConfidence: 1 }],
        nextSetCode: null as string | null,
      }
    : await (async () => {
        providerSetIndexBackfilled = await maybeBackfillProviderSetMap();
        const sets = await loadCanonicalSetsForPokeTrace();
        const allTargets: IngestTarget[] = sets.map((set) => ({
          setCode: set.setCode,
          setName: set.setName,
          providerSetId: set.providerSetId ?? normalizeProviderSetSlugFromCanonical(set.setName),
          mapConfidence: set.mapConfidence,
        }));
        const byProviderSetId = new Map(allTargets.map((target) => [target.providerSetId, target] as const));
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
        const cursorTargets = sortTargetsByFreshness(
          selectSetsFromCursor(sets, sets.length, priorState.cursorSetCode)
            .flatMap((set) => {
              const target = byProviderSetId.get(set.providerSetId ?? "");
              return target ? [target] : [];
            }),
          healthByProviderSet,
        );
        const selectedTargets: IngestTarget[] = [];
        const seenProviderSetIds = new Set<string>();
        const addTarget = (target: IngestTarget | null | undefined) => {
          if (!target) return;
          if (selectedTargets.length >= setLimit) return;
          if (seenProviderSetIds.has(target.providerSetId)) return;
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
            return;
          }
          seenProviderSetIds.add(target.providerSetId);
          selectedTargets.push(target);
        };
        for (const providerSetId of failedSetQueue) {
          addTarget(byProviderSetId.get(providerSetId) ?? {
            setCode: null,
            setName: null,
            providerSetId,
            mapConfidence: 0,
          });
        }
        for (const target of cursorTargets) {
          addTarget(target);
          if (selectedTargets.length >= setLimit) break;
        }
        const nextSetCode = cursorTargets.at(Math.min(setLimit, cursorTargets.length) - 1)?.setCode
          ?? priorState.cursorSetCode
          ?? null;
        return { selectedTargets, nextSetCode };
      })();
  let resolvedTargets = targets.selectedTargets;
  const nextSetCode = targets.nextSetCode;
  const cursorSetCode = priorState.cursorSetCode;
  const liveSetLookupBudget = opts.providerSetId
    ? 0
    : Math.min(
        DEFAULT_SET_LOOKUP_MAX_REQUESTS,
        Math.max(0, maxRequests - resolvedTargets.length),
      );
  if (!opts.providerSetId && liveSetLookupBudget > 0) {
    const resolution = await resolveTargetsFromLiveSetIndex({
      targets: resolvedTargets,
      credentials,
      maxRequests: liveSetLookupBudget,
    });
    resolvedTargets = resolution.targets;
    liveSetLookupRequests = resolution.requestsMade;
    requestsMade += liveSetLookupRequests;
    for (const warning of resolution.warningSamples) {
      if (warningSamples.length >= 25) break;
      warningSamples.push(warning);
    }
  } else if (
    !opts.providerSetId
    && liveSetLookupBudget === 0
    && resolvedTargets.some((target) => target.mapConfidence <= 0)
    && warningSamples.length < 25
  ) {
    warningSamples.push("live set lookup skipped because request budget was fully reserved for card pages");
  }
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
        mode: "raw-only",
        pageLimit: PAGE_LIMIT,
        pageLimitPerSet,
        maxRequests,
        liveSetLookupRequests,
        retryAttempts,
        retryBackoffMs,
        requestDelayMs,
        providerSetId: opts.providerSetId ?? null,
        cursorSetCode,
        nextSetCode,
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
    if (requestsMade >= maxRequests) break;
    setsProcessed += 1;

    let pagesFetched = 0;
    let cardsFetchedForSet = 0;
    let cursor: string | null = null;
    let hasMore = false;
    let lastStatus: number | null = null;
    let requestAttemptsForSet = 0;
    let setLastError: string | null = null;
    let setHadSuccess = false;
    let setHadRetryableFailure = false;

    while (requestsMade < maxRequests && pagesFetched < pageLimitPerSet) {
      let pageSucceeded = false;
      for (let attempt = 1; attempt <= retryAttempts && requestsMade < maxRequests; attempt += 1) {
        const fetchedAt = new Date().toISOString();
        requestsMade += 1;
        requestAttemptsForSet += 1;
        try {
          const payload = await fetchPokeTraceCardsPage({
            setSlug: target.providerSetId,
            cursor,
            limit: PAGE_LIMIT,
            market: "US",
            credentials,
          });
          const cards = payload.data ?? [];
          const rawEnvelope: { data: PokeTraceCard[]; pagination?: Record<string, unknown> | null } = {
            data: cards,
            pagination: payload.pagination ?? null,
          };

          const rawInsert = await insertRawPayloadRow({
            providerSetId: target.providerSetId,
            cursor,
            body: rawEnvelope,
            statusCode: 200,
            fetchedAt,
          });
          if (rawInsert.inserted) rawPayloadsInserted += 1;
          if (rawInsert.duplicate) rawPayloadsDuplicate += 1;

          pagesFetched += 1;
          lastStatus = 200;
          cardsFetched += cards.length;
          cardsFetchedForSet += cards.length;
          setHadSuccess = true;

          cursor = String(payload.pagination?.nextCursor ?? payload.nextCursor ?? "").trim() || null;
          hasMore = Boolean(cursor);
          await delayMs(requestDelayMs);
          if (!hasMore || cards.length === 0) {
            pageSucceeded = true;
            break;
          }

          pageSucceeded = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const statusCode = extractPokeTraceHttpStatus(message);
          if (statusCode !== null) {
            lastStatus = statusCode;
          } else if (lastStatus === null && isRetryablePokeTraceError(message)) {
            lastStatus = 429;
          }
          const shouldCooldown = statusCode === 429 || (typeof statusCode === "number" && statusCode >= 500);
          if (shouldCooldown) setHadRetryableFailure = true;
          setLastError = message;
          const canRetry = attempt < retryAttempts && (shouldCooldown || isRetryablePokeTraceError(message)) && requestsMade < maxRequests;
          if (canRetry) {
            await delayMs(retryBackoffMs * attempt);
            continue;
          }
          firstError ??= message;
          failedRequests += 1;
          if (shouldCooldown) {
            cooldownByProviderSet[target.providerSetId] = new Date(Date.now() + cooldownMs).toISOString();
          }
          if (warningSamples.length < 25) {
            warningSamples.push(
              `set=${target.providerSetId} cursor=${cursor ?? "start"} status=${lastStatus ?? "error"} attempts=${attempt}`,
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
    liveSetLookupRequests,
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
          liveSetLookupRequests,
          retryAttempts,
          retryBackoffMs,
          requestDelayMs,
          providerSetId: opts.providerSetId ?? null,
          cursorSetCode,
          nextSetCode,
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
