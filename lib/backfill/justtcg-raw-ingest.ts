import crypto from "node:crypto";
import { dbAdmin } from "@/lib/db/admin";
import { fetchJustTcgCardsPage, setNameToJustTcgId } from "@/lib/providers/justtcg";
import { loadProviderSetIndex } from "@/lib/backfill/provider-set-index";

const PROVIDER = "JUSTTCG";
const JOB = "justtcg_raw_ingest";
const PAGE_LIMIT = 20;
const DEFAULT_SETS_PER_RUN = process.env.JUSTTCG_RAW_SETS_PER_RUN
  ? parseInt(process.env.JUSTTCG_RAW_SETS_PER_RUN, 10)
  : 40;
const DEFAULT_MAX_REQUESTS = process.env.JUSTTCG_RAW_MAX_REQUESTS
  ? parseInt(process.env.JUSTTCG_RAW_MAX_REQUESTS, 10)
  : 400;
const DEFAULT_RETRY_ATTEMPTS = process.env.JUSTTCG_RAW_RETRY_ATTEMPTS
  ? parseInt(process.env.JUSTTCG_RAW_RETRY_ATTEMPTS, 10)
  : 2;
const DEFAULT_REQUEST_DELAY_MS = process.env.JUSTTCG_RAW_REQUEST_DELAY_MS
  ? parseInt(process.env.JUSTTCG_RAW_REQUEST_DELAY_MS, 10)
  : 125;
const DEFAULT_SET_DELAY_MS = process.env.JUSTTCG_RAW_SET_DELAY_MS
  ? parseInt(process.env.JUSTTCG_RAW_SET_DELAY_MS, 10)
  : 250;
const DEFAULT_COOLDOWN_MINUTES = process.env.JUSTTCG_RAW_COOLDOWN_MINUTES
  ? parseInt(process.env.JUSTTCG_RAW_COOLDOWN_MINUTES, 10)
  : 180;
const DEFAULT_MAX_ADAPTIVE_DELAY_MS = process.env.JUSTTCG_RAW_MAX_ADAPTIVE_DELAY_MS
  ? parseInt(process.env.JUSTTCG_RAW_MAX_ADAPTIVE_DELAY_MS, 10)
  : 2000;
const DEFAULT_FAILED_QUEUE_LIMIT = process.env.JUSTTCG_FAILED_SET_QUEUE_LIMIT
  ? parseInt(process.env.JUSTTCG_FAILED_SET_QUEUE_LIMIT, 10)
  : 200;
const PRIORITY_SET_CODES = (process.env.JUSTTCG_PRIORITY_SET_CODES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

type CanonicalSet = {
  setCode: string;
  setName: string;
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

type RawIngestSetSummary = {
  canonicalSetCode: string | null;
  canonicalSetName: string | null;
  providerSetId: string;
  pagesFetched: number;
  cardsFetched: number;
  lastStatus: number | null;
  hasMore: boolean;
};

type LastRunRow = {
  meta: Record<string, unknown> | null;
};

type IngestTarget = {
  setCode: string | null;
  setName: string | null;
  providerSetId: string;
};

type IngestRunState = {
  cursorSetCode: string | null;
  failedSetQueue: string[];
  cooldownByProviderSet: Record<string, string>;
};

type RawIngestResult = {
  ok: boolean;
  job: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  setsPlanned: number;
  setsProcessed: number;
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
    if (!key) continue;
    if (typeof raw !== "string") continue;
    const ms = new Date(raw).getTime();
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
  const cursorSetCode = cursorRaw.trim() || null;
  const failedSetQueue = parseStringArray(meta.failedSetQueue);
  const cooldownByProviderSet = parseCooldownMap(meta.cooldownByProviderSet);

  return {
    cursorSetCode,
    failedSetQueue,
    cooldownByProviderSet,
  };
}

function delayMs(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCanonicalSetsFromPrintings(): Promise<CanonicalSet[]> {
  const supabase = dbAdmin();
  const pageSize = 5000;
  const seen = new Set<string>();
  const sets: CanonicalSet[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("set_code, set_name")
      .eq("language", "EN")
      .not("set_code", "is", null)
      .not("set_name", "is", null)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`card_printings: ${error.message}`);
    }

    const rows = data ?? [];
    for (const row of rows) {
      const setCode = String(row.set_code ?? "");
      const setName = String(row.set_name ?? "");
      if (!setCode || !setName || seen.has(setCode)) continue;
      seen.add(setCode);
      sets.push({ setCode, setName });
    }

    if (rows.length < pageSize) break;
  }

  sets.sort((left, right) => left.setCode.localeCompare(right.setCode));
  return sets;
}

async function maybeBackfillProviderSetMap(): Promise<number> {
  // Keep the default ingest path lightweight. Only scan canonical printings weekly
  // to seed missing provider_set_map rows for new sets.
  if (new Date().getUTCDay() !== 0) return 0;
  const supabase = dbAdmin();
  const [knownResult, canonicalSets] = await Promise.all([
    supabase
      .from("provider_set_map")
      .select("canonical_set_code")
      .eq("provider", PROVIDER),
    loadCanonicalSetsFromPrintings(),
  ]);

  if (knownResult.error) {
    throw new Error(`provider_set_map(existing): ${knownResult.error.message}`);
  }

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
    provider_set_id: setNameToJustTcgId(set.setName),
    confidence: 0,
  }));

  const { error } = await supabase
    .from("provider_set_map")
    .upsert(rows, { onConflict: "provider,canonical_set_code" });
  if (error) throw new Error(`provider_set_map(backfill): ${error.message}`);
  return rows.length;
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
  const untilMs = new Date(untilIso).getTime();
  if (!Number.isFinite(untilMs)) return { active: false, untilIso: null };
  if (untilMs <= params.nowMs) return { active: false, untilIso };
  return { active: true, untilIso };
}

function pruneCooldowns(cooldownByProviderSet: Record<string, string>, nowMs: number): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [providerSetId, untilIso] of Object.entries(cooldownByProviderSet)) {
    const untilMs = new Date(untilIso).getTime();
    if (!Number.isFinite(untilMs)) continue;
    if (untilMs <= nowMs) continue;
    output[providerSetId] = untilIso;
  }
  return output;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
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

async function insertRawPayloadRow(params: {
  providerSetId: string;
  offset: number;
  body: unknown;
  statusCode: number;
  fetchedAt: string;
}) {
  const { providerSetId, offset, body, statusCode, fetchedAt } = params;
  const supabase = dbAdmin();
  const payload = {
    provider: PROVIDER,
    endpoint: "/cards",
    params: {
      set: providerSetId,
      offset,
      limit: PAGE_LIMIT,
      priceHistoryDuration: "30d",
    },
    response: body ?? {},
    status_code: statusCode,
    fetched_at: fetchedAt,
    request_hash: requestHash("/cards", {
      set: providerSetId,
      offset,
      limit: PAGE_LIMIT,
      priceHistoryDuration: "30d",
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

export async function runJustTcgRawIngest(opts: {
  setLimit?: number;
  providerSetId?: string | null;
  pageLimitPerSet?: number;
  maxRequests?: number;
  retryOnly?: boolean;
} = {}): Promise<RawIngestResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const setLimit = parsePositiveInt(opts.setLimit, DEFAULT_SETS_PER_RUN);
  const pageLimitPerSet = parsePositiveInt(opts.pageLimitPerSet, 100);
  const maxRequests = parsePositiveInt(opts.maxRequests, DEFAULT_MAX_REQUESTS);
  const retryAttempts = parsePositiveInt(DEFAULT_RETRY_ATTEMPTS, 2);
  const requestDelayMs = Math.max(0, parsePositiveInt(DEFAULT_REQUEST_DELAY_MS, 125));
  const setDelayMs = Math.max(0, parsePositiveInt(DEFAULT_SET_DELAY_MS, 250));
  const cooldownMinutes = parsePositiveInt(DEFAULT_COOLDOWN_MINUTES, 180);
  const maxAdaptiveDelayMs = Math.max(requestDelayMs, parsePositiveInt(DEFAULT_MAX_ADAPTIVE_DELAY_MS, 2000));
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
  let adaptiveDelayMs = requestDelayMs;
  const nowMs = Date.now();

  const priorState = opts.providerSetId
    ? { cursorSetCode: null, failedSetQueue: [] as string[], cooldownByProviderSet: {} as Record<string, string> }
    : await loadLastRunState();
  let failedSetQueue = normalizeFailedSetQueue(priorState.failedSetQueue);
  let cooldownByProviderSet = pruneCooldowns(priorState.cooldownByProviderSet, nowMs);

  const targets = opts.providerSetId
    ? [{ setCode: null, setName: null, providerSetId: opts.providerSetId }]
    : await (async () => {
        providerSetIndexBackfilled = await maybeBackfillProviderSetMap();
        const providerSetIndex = await loadProviderSetIndex("JUSTTCG");
        const allTargets = providerSetIndex.map((row) => ({
          setCode: row.canonicalSetCode,
          setName: row.canonicalSetName ?? row.canonicalSetCode,
          providerSetId: row.providerSetId,
        }));
        if (allTargets.length === 0) {
          const fallbackSets = await loadCanonicalSetsFromPrintings();
          for (const set of fallbackSets) {
            allTargets.push({
              setCode: set.setCode,
              setName: set.setName,
              providerSetId: setNameToJustTcgId(set.setName),
            });
          }
          warningSamples.push("provider_set_map index empty; using canonical printings fallback");
        }
        const sets = allTargets
          .map((target) => ({ setCode: target.setCode ?? "", setName: target.setName ?? target.setCode ?? "" }))
          .filter((set): set is CanonicalSet => Boolean(set.setCode && set.setName));
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
        const byProviderSetId = new Map(allTargets.map((target) => [target.providerSetId, target] as const));
        const bySetCode = new Map(allTargets.map((target) => [target.setCode, target] as const));
        const cursorCandidates = sortTargetsByFreshness(
          selectSetsFromCursor(sets, sets.length, priorState.cursorSetCode)
            .flatMap((set) => {
              const target = bySetCode.get(set.setCode);
              return target ? [target] : [];
            }),
          healthByProviderSet,
        );

        const selectedTargets: IngestTarget[] = [];
        const selectedProviderIds = new Set<string>();
        const addIfEligible = (target: IngestTarget | undefined | null) => {
          if (!target) return;
          if (selectedTargets.length >= setLimit) return;
          if (selectedProviderIds.has(target.providerSetId)) return;
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
          selectedProviderIds.add(target.providerSetId);
          selectedTargets.push(target);
        };

        for (const providerSetId of failedSetQueue) {
          addIfEligible(byProviderSetId.get(providerSetId) ?? {
            setCode: null,
            setName: null,
            providerSetId,
          });
        }
        if (!opts.retryOnly) {
          for (const setCode of PRIORITY_SET_CODES) addIfEligible(bySetCode.get(setCode) ?? null);
          for (const target of cursorCandidates) {
            addIfEligible(target);
            if (selectedTargets.length >= setLimit) break;
          }
        }

        const nextSetCode = opts.retryOnly
          ? (priorState.cursorSetCode ?? null)
          : (cursorCandidates.at(Math.min(setLimit, cursorCandidates.length) - 1)?.setCode ?? priorState.cursorSetCode ?? null);

        return {
          selectedTargets,
          nextSetCode,
        };
      })();
  const resolvedTargets = Array.isArray(targets)
    ? targets
    : targets.selectedTargets;
  const nextSetCode = Array.isArray(targets)
    ? null
    : targets.nextSetCode;
  const cursorSetCode = priorState.cursorSetCode;
  const providerSetHealthBySet = await loadProviderSetHealth(resolvedTargets.map((target) => target.providerSetId));
  const providerSetHealthUpserts: ProviderSetHealthUpsertRow[] = [];

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
        mode: "raw-only",
        pageLimit: PAGE_LIMIT,
        pageLimitPerSet,
        maxRequests,
        providerSetId: opts.providerSetId ?? null,
        retryOnly: opts.retryOnly === true,
        cursorSetCode,
        nextSetCode,
        setsPlanned: resolvedTargets.length,
        skippedCooldownSets,
        skippedCooldownSamples,
        providerSetIndexBackfilled,
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
    let offset = 0;
    let hasMore = false;
    let lastStatus: number | null = null;
    let setLastError: string | null = null;

    let setHadSuccess = false;
    let setHadRetryableFailure = false;

    while (requestsMade < maxRequests && pagesFetched < pageLimitPerSet) {
      const fetchedAt = new Date().toISOString();
      const page = Math.floor(offset / PAGE_LIMIT) + 1;
      let response: Awaited<ReturnType<typeof fetchJustTcgCardsPage>> | null = null;
      let attempts = 0;
      while (attempts <= retryAttempts && requestsMade < maxRequests) {
        attempts += 1;
        response = await fetchJustTcgCardsPage(target.providerSetId, page, {
          limit: PAGE_LIMIT,
          offset,
          priceHistoryDuration: "30d",
        });
        requestsMade += 1;
        lastStatus = response.httpStatus;

        if (response.httpStatus >= 200 && response.httpStatus < 300) break;
        const shouldRetry = response.httpStatus === 429 || response.httpStatus >= 500;
        if (response.httpStatus === 429) setHadRetryableFailure = true;
        if (!shouldRetry || attempts > retryAttempts) break;
        adaptiveDelayMs = Math.min(maxAdaptiveDelayMs, Math.max(requestDelayMs, adaptiveDelayMs * 2));
        const retryDelay = Math.min(maxAdaptiveDelayMs, adaptiveDelayMs * (attempts + 1));
        await delayMs(retryDelay);
      }

      if (!response) {
        firstError ??= `JustTCG request failed without response for set ${target.providerSetId}`;
        setLastError = `no response for page ${page}`;
        failedRequests += 1;
        break;
      }

      try {
        const rawInsert = await insertRawPayloadRow({
          providerSetId: target.providerSetId,
          offset,
          body: response.rawEnvelope,
          statusCode: response.httpStatus,
          fetchedAt,
        });
        if (rawInsert.inserted) rawPayloadsInserted += 1;
        if (rawInsert.duplicate) rawPayloadsDuplicate += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        firstError ??= message;
        setLastError = message;
        failedRequests += 1;
        break;
      }

      pagesFetched += 1;

      if (response.httpStatus < 200 || response.httpStatus >= 300) {
        failedRequests += 1;
        setLastError = `status ${response.httpStatus} page ${page}`;
        if (response.httpStatus === 429 || response.httpStatus >= 500) {
          setHadRetryableFailure = true;
          const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
          cooldownByProviderSet[target.providerSetId] = cooldownUntil;
        }
        if (warningSamples.length < 25) {
          warningSamples.push(
            `set=${target.providerSetId} page=${page} status=${response.httpStatus} attempts=${attempts}`,
          );
        }
        hasMore = false;
        break;
      }

      cardsFetched += response.cards.length;
      cardsFetchedForSet += response.cards.length;
      hasMore = response.hasMore;
      setHadSuccess = true;
      adaptiveDelayMs = Math.max(requestDelayMs, Math.floor(adaptiveDelayMs * 0.9));

      if (!response.hasMore || response.cards.length === 0) break;
      offset += PAGE_LIMIT;
      await delayMs(adaptiveDelayMs);
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

    if (setDelayMs > 0) {
      await delayMs(setDelayMs);
    }

    const previousHealth = providerSetHealthBySet.get(target.providerSetId);
    const nowIso = new Date().toISOString();
    const consecutive429 = lastStatus === 429
      ? (Math.max(0, previousHealth?.consecutive_429 ?? 0) + 1)
      : 0;
    const cooldownUntil = cooldownByProviderSet[target.providerSetId] ?? null;
    const nextRetryAt = cooldownUntil;
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
      next_retry_at: nextRetryAt,
      last_error: setLastError,
      requests_last_run: pagesFetched,
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
  }

  cooldownByProviderSet = pruneCooldowns(cooldownByProviderSet, Date.now());

  if (providerSetHealthUpserts.length > 0) {
    const dedupedByProviderSet = new Map<string, ProviderSetHealthUpsertRow>();
    for (const row of providerSetHealthUpserts) dedupedByProviderSet.set(row.provider_set_id, row);
    const { error: healthUpsertError } = await supabase
      .from("provider_set_health")
      .upsert([...dedupedByProviderSet.values()], { onConflict: "provider,provider_set_id" });
    if (healthUpsertError) {
      firstError ??= `provider_set_health(upsert): ${healthUpsertError.message}`;
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
          providerSetId: opts.providerSetId ?? null,
          retryOnly: opts.retryOnly === true,
          cursorSetCode,
          nextSetCode,
          setsPlanned: resolvedTargets.length,
          setsProcessed,
          requestsMade,
          rawPayloadsInserted,
          rawPayloadsDuplicate,
          sampleSetResults,
          warningCount: failedRequests,
          warningSamples,
          skippedCooldownSets,
          skippedCooldownSamples,
          providerSetIndexBackfilled,
          failedSetQueue,
          cooldownByProviderSet,
          adaptiveDelayMs,
          providerSetHealthRowsWritten: providerSetHealthUpserts.length,
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}
