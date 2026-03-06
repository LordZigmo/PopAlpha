import crypto from "node:crypto";
import { dbAdmin } from "@/lib/db/admin";
import { fetchJustTcgCardsPage, setNameToJustTcgId } from "@/lib/providers/justtcg";

const PROVIDER = "JUSTTCG";
const JOB = "justtcg_raw_ingest";
const PAGE_LIMIT = 20;
const DEFAULT_SETS_PER_RUN = process.env.JUSTTCG_RAW_SETS_PER_RUN
  ? parseInt(process.env.JUSTTCG_RAW_SETS_PER_RUN, 10)
  : 10;
const DEFAULT_MAX_REQUESTS = process.env.JUSTTCG_RAW_MAX_REQUESTS
  ? parseInt(process.env.JUSTTCG_RAW_MAX_REQUESTS, 10)
  : 200;

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

async function loadLastCursorSetCode(): Promise<string | null> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("ingest_runs")
    .select("meta")
    .eq("job", JOB)
    .eq("status", "finished")
    .eq("ok", true)
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle<LastRunRow>();

  if (error) throw new Error(`ingest_runs(last cursor): ${error.message}`);
  const value = typeof data?.meta?.nextSetCode === "string" ? data.meta.nextSetCode.trim() : "";
  return value || null;
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
} = {}): Promise<RawIngestResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const setLimit = parsePositiveInt(opts.setLimit, DEFAULT_SETS_PER_RUN);
  const pageLimitPerSet = parsePositiveInt(opts.pageLimitPerSet, 100);
  const maxRequests = parsePositiveInt(opts.maxRequests, DEFAULT_MAX_REQUESTS);

  let firstError: string | null = null;
  let requestsMade = 0;
  let rawPayloadsInserted = 0;
  let rawPayloadsDuplicate = 0;
  let cardsFetched = 0;
  let failedRequests = 0;
  let setsProcessed = 0;
  const sampleSetResults: RawIngestSetSummary[] = [];

  const cursorSetCode = opts.providerSetId ? null : await loadLastCursorSetCode();
  const targets = opts.providerSetId
    ? [{ setCode: null, setName: null, providerSetId: opts.providerSetId }]
    : await (async () => {
        const sets = await loadCanonicalSets();
        const selectedSets = selectSetsFromCursor(sets, setLimit, cursorSetCode);
        const providerSetMap = await loadProviderSetMap(selectedSets.map((set) => set.setCode));
        return selectedSets.map((set) => ({
          setCode: set.setCode,
          setName: set.setName,
          providerSetId: providerSetMap.get(set.setCode) ?? setNameToJustTcgId(set.setName),
        }));
      })();
  const nextSetCode = targets.length > 0 && !opts.providerSetId
    ? (targets[targets.length - 1]?.setCode ?? null)
    : null;

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
        setsPlanned: targets.length,
      },
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (runStartError) {
    throw new Error(`ingest_runs(start): ${runStartError.message}`);
  }

  const runId = runRow?.id ?? null;

  for (const target of targets) {
    if (requestsMade >= maxRequests) break;
    setsProcessed += 1;

    let pagesFetched = 0;
    let cardsFetchedForSet = 0;
    let offset = 0;
    let hasMore = false;
    let lastStatus: number | null = null;

    while (requestsMade < maxRequests && pagesFetched < pageLimitPerSet) {
      const fetchedAt = new Date().toISOString();
      const page = Math.floor(offset / PAGE_LIMIT) + 1;
      const response = await fetchJustTcgCardsPage(target.providerSetId, page, {
        limit: PAGE_LIMIT,
        offset,
        priceHistoryDuration: "30d",
      });

      requestsMade += 1;
      lastStatus = response.httpStatus;

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
        firstError ??= `JustTCG ${response.httpStatus} for set ${target.providerSetId}`;
        failedRequests += 1;
        hasMore = false;
        break;
      }

      cardsFetched += response.cards.length;
      cardsFetchedForSet += response.cards.length;
      hasMore = response.hasMore;

      if (!response.hasMore || response.cards.length === 0) break;
      offset += PAGE_LIMIT;
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
  }

  const endedAt = new Date().toISOString();
  const result: RawIngestResult = {
    ok: failedRequests === 0 && firstError === null,
    job: JOB,
    provider: PROVIDER,
    startedAt,
    endedAt,
    setsPlanned: targets.length,
    setsProcessed,
    requestsMade,
    rawPayloadsInserted,
    rawPayloadsDuplicate,
    cardsFetched,
    failedRequests,
    pageLimit: PAGE_LIMIT,
    sampleSetResults,
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
          setsPlanned: targets.length,
          setsProcessed,
          requestsMade,
          rawPayloadsInserted,
          rawPayloadsDuplicate,
          sampleSetResults,
          firstError,
        },
      })
      .eq("id", runId);
  }

  return result;
}
