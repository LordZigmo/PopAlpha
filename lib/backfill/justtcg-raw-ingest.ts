import crypto from "node:crypto";
import { dbAdmin } from "@/lib/db/admin";
import { fetchJustTcgCardsPage, setNameToJustTcgId } from "@/lib/providers/justtcg";

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

type SetMapRow = {
  canonical_set_code: string;
  provider_set_id: string;
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

async function loadCanonicalSets(): Promise<CanonicalSet[]> {
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

async function loadProviderSetMap(setCodes: string[]): Promise<Map<string, string>> {
  if (setCodes.length === 0) return new Map();

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code, provider_set_id")
    .eq("provider", PROVIDER)
    .in("canonical_set_code", setCodes);

  if (error) {
    throw new Error(`provider_set_map: ${error.message}`);
  }

  const byCode = new Map<string, string>();
  for (const row of (data ?? []) as SetMapRow[]) {
    byCode.set(row.canonical_set_code, row.provider_set_id);
  }
  return byCode;
}

function buildAllTargets(params: {
  sets: CanonicalSet[];
  providerSetMap: Map<string, string>;
}): IngestTarget[] {
  return params.sets.map((set) => ({
    setCode: set.setCode,
    setName: set.setName,
    providerSetId: params.providerSetMap.get(set.setCode) ?? setNameToJustTcgId(set.setName),
  }));
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
        const sets = await loadCanonicalSets();
        const providerSetMap = await loadProviderSetMap(sets.map((set) => set.setCode));
        const allTargets = buildAllTargets({ sets, providerSetMap });
        const byProviderSetId = new Map(allTargets.map((target) => [target.providerSetId, target] as const));
        const bySetCode = new Map(allTargets.map((target) => [target.setCode, target] as const));
        const cursorCandidates = selectSetsFromCursor(sets, sets.length, priorState.cursorSetCode)
          .map((set) => bySetCode.get(set.setCode))
          .filter((target): target is IngestTarget => Boolean(target));

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
        cursorSetCode,
        nextSetCode,
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
    let offset = 0;
    let hasMore = false;
    let lastStatus: number | null = null;

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
        failedRequests += 1;
        break;
      }

      pagesFetched += 1;

      if (response.httpStatus < 200 || response.httpStatus >= 300) {
        failedRequests += 1;
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
  }

  cooldownByProviderSet = pruneCooldowns(cooldownByProviderSet, Date.now());

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
          failedSetQueue,
          cooldownByProviderSet,
          adaptiveDelayMs,
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}
