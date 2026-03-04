import crypto from "node:crypto";
import { dbAdmin } from "@/lib/db/admin";
import { fetchEpisodeCards } from "@/lib/providers/pokemon-tcg-api";

const PROVIDER = "POKEMON_TCG_API";
const JOB = "pokemontcg_raw_ingest";
const ENDPOINT = "/episodes/cards";
const PAGE_LIMIT = 20;
const DEFAULT_SETS_PER_RUN = process.env.POKEMONTCG_RAW_SETS_PER_RUN
  ? parseInt(process.env.POKEMONTCG_RAW_SETS_PER_RUN, 10)
  : 10;
const DEFAULT_MAX_REQUESTS = process.env.POKEMONTCG_RAW_MAX_REQUESTS
  ? parseInt(process.env.POKEMONTCG_RAW_MAX_REQUESTS, 10)
  : 200;

type SetMapRow = {
  canonical_set_code: string;
  canonical_set_name: string | null;
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

async function loadTargetSets(params: {
  setLimit: number;
  providerSetId?: string | null;
}): Promise<Array<{ setCode: string | null; setName: string | null; providerSetId: string }>> {
  if (params.providerSetId) {
    return [{ setCode: null, setName: null, providerSetId: params.providerSetId }];
  }

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code, canonical_set_name, provider_set_id")
    .eq("provider", PROVIDER)
    .gt("confidence", 0)
    .order("canonical_set_code", { ascending: true })
    .limit(params.setLimit);

  if (error) throw new Error(`provider_set_map: ${error.message}`);

  return ((data ?? []) as SetMapRow[]).map((row) => ({
    setCode: row.canonical_set_code,
    setName: row.canonical_set_name ?? null,
    providerSetId: row.provider_set_id,
  }));
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
      episodeId: providerSetId,
      page,
      limit: PAGE_LIMIT,
    },
    response: body ?? {},
    status_code: statusCode,
    fetched_at: fetchedAt,
    request_hash: requestHash(ENDPOINT, {
      episodeId: providerSetId,
      page,
      limit: PAGE_LIMIT,
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

  const targets = await loadTargetSets({
    setLimit,
    providerSetId: opts.providerSetId,
  });

  const { data: runRow, error: runStartError } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "pokemontcg",
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
    const numericSetId = parseInt(target.providerSetId, 10);
    if (!Number.isFinite(numericSetId)) {
      firstError ??= `Invalid provider_set_id for ${PROVIDER}: ${target.providerSetId}`;
      failedRequests += 1;
      continue;
    }

    while (requestsMade < maxRequests && pagesFetched < pageLimitPerSet) {
      const fetchedAt = new Date().toISOString();
      const response = await fetchEpisodeCards(numericSetId, page);
      const rawEnvelope = { data: response.cards };

      requestsMade += 1;
      lastStatus = response.httpStatus;

      try {
        const rawInsert = await insertRawPayloadRow({
          providerSetId: target.providerSetId,
          page,
          body: rawEnvelope,
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
        firstError ??= `${PROVIDER} ${response.httpStatus} for episode ${target.providerSetId}`;
        failedRequests += 1;
        hasMore = false;
        break;
      }

      cardsFetched += response.cards.length;
      cardsFetchedForSet += response.cards.length;
      hasMore = response.hasMore;

      if (!response.hasMore || response.cards.length === 0) break;
      page += 1;
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
