import crypto from "node:crypto";
import { dbAdmin } from "@/lib/db/admin";
import { fetchCardsPage, getScrydexCredentials, type ScrydexCard } from "@/lib/scrydex/client";

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

type CanonicalSet = {
  setCode: string;
  setName: string;
};

type LastRunRow = {
  meta: Record<string, unknown> | null;
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

    if (error) throw new Error(`card_printings: ${error.message}`);

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

  let credentials: ReturnType<typeof getScrydexCredentials>;
  try {
    credentials = getScrydexCredentials();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const cursorSetCode = opts.providerSetId ? null : await loadLastCursorSetCode();
  const targets = opts.providerSetId
    ? [{ setCode: null, setName: null, providerSetId: opts.providerSetId }]
    : await (async () => {
        const sets = await loadCanonicalSets();
        const selectedSets = selectSetsFromCursor(sets, setLimit, cursorSetCode);
        return selectedSets.map((set) => ({
          setCode: set.setCode,
          setName: set.setName,
          providerSetId: set.setCode,
        }));
      })();
  const nextSetCode = targets.length > 0 && !opts.providerSetId
    ? (targets[targets.length - 1]?.setCode ?? null)
    : null;

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
    let page = 1;
    let hasMore = false;
    let lastStatus: number | null = null;

    while (requestsMade < maxRequests && pagesFetched < pageLimitPerSet) {
      const fetchedAt = new Date().toISOString();

      requestsMade += 1;
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
        if (rawInsert.duplicate) rawPayloadsDuplicate += 1;

        pagesFetched += 1;
        lastStatus = 200;
        cardsFetched += cards.length;
        cardsFetchedForSet += cards.length;

        hasMore = cards.length >= PAGE_LIMIT && (typeof payload.totalCount !== "number" || (page * PAGE_LIMIT) < payload.totalCount);
        if (!hasMore || cards.length === 0) break;

        page += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        firstError ??= message;
        failedRequests += 1;
        lastStatus = 500;
        hasMore = false;
        break;
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
