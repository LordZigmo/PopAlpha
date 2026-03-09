const BASE_URL = "https://api.poketrace.com/v1";
const DEFAULT_TIMEOUT_MS = process.env.POKETRACE_HTTP_TIMEOUT_MS
  ? Math.max(1000, parseInt(process.env.POKETRACE_HTTP_TIMEOUT_MS, 10))
  : 30000;
const DEFAULT_RETRY_ATTEMPTS = process.env.POKETRACE_HTTP_RETRY_ATTEMPTS
  ? Math.max(1, parseInt(process.env.POKETRACE_HTTP_RETRY_ATTEMPTS, 10))
  : 3;
const DEFAULT_RETRY_BACKOFF_MS = process.env.POKETRACE_HTTP_RETRY_BACKOFF_MS
  ? Math.max(250, parseInt(process.env.POKETRACE_HTTP_RETRY_BACKOFF_MS, 10))
  : 2000;

export type PokeTraceCredentials = {
  apiKey: string;
};

export function getPokeTraceCredentials(): PokeTraceCredentials {
  const apiKey = process.env.POKETRACE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Missing POKETRACE_API_KEY. Add it to .env.local from the PokeTrace developer dashboard."
    );
  }
  return { apiKey };
}

export type PokeTraceSet = {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
  releaseDate?: string | null;
  totalCards?: number | null;
};

export type PokeTraceCard = {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
  number?: string | null;
  cardNumber?: string | null;
  variant?: string | null;
  finish?: string | null;
  rarity?: string | null;
  language?: string | null;
  image?: string | null;
  images?: {
    small?: string | null;
    large?: string | null;
  } | null;
  set?: {
    id?: string | null;
    slug?: string | null;
    name?: string | null;
  } | null;
  prices?: Record<string, unknown> | null;
};

export type PokeTraceListPayload<T> = {
  data?: T[];
  pagination?: {
    nextCursor?: string | null;
    hasMore?: boolean;
    limit?: number | null;
    total?: number | null;
  } | null;
  nextCursor?: string | null;
};

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(headerValue);
  if (!Number.isFinite(dateMs)) return null;
  const delta = dateMs - Date.now();
  return delta > 0 ? delta : 0;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408
    || status === 409
    || status === 425
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504;
}

function isRetryableNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("fetch failed")
    || message.includes("network")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("socket")
    || message.includes("econnreset")
    || message.includes("etimedout")
    || message.includes("eai_again");
}

export async function fetchPokeTraceJson<T>(
  path: string,
  params: URLSearchParams,
  credentials: PokeTraceCredentials,
): Promise<T> {
  const url = `${BASE_URL}${path}?${params.toString()}`;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= DEFAULT_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "X-API-Key": credentials.apiKey,
        },
        cache: "no-store",
        signal: controller.signal,
      });

      if (response.ok) {
        clearTimeout(timeout);
        return (await response.json()) as T;
      }

      const body = (await response.text()).slice(0, 400);
      lastError = `PokeTrace API error ${response.status}: ${body}`;
      const canRetry = attempt < DEFAULT_RETRY_ATTEMPTS && isRetryableHttpStatus(response.status);
      clearTimeout(timeout);
      if (!canRetry) break;

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const backoffMs = retryAfterMs ?? (DEFAULT_RETRY_BACKOFF_MS * attempt);
      await sleep(backoffMs);
      continue;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error instanceof Error ? error.message : String(error);
      const canRetry = attempt < DEFAULT_RETRY_ATTEMPTS && isRetryableNetworkError(error);
      if (!canRetry) break;
      await sleep(DEFAULT_RETRY_BACKOFF_MS * attempt);
      continue;
    }
  }

  throw new Error(lastError ?? "PokeTrace API request failed");
}

export async function fetchPokeTraceSetsPage(params: {
  cursor?: string | null;
  limit?: number;
  credentials: PokeTraceCredentials;
}): Promise<PokeTraceListPayload<PokeTraceSet>> {
  const search = new URLSearchParams();
  search.set("limit", String(Math.max(1, Math.min(params.limit ?? 100, 100))));
  if (params.cursor) search.set("cursor", params.cursor);
  return fetchPokeTraceJson<PokeTraceListPayload<PokeTraceSet>>("/sets", search, params.credentials);
}

export async function fetchPokeTraceCardsPage(params: {
  setSlug?: string | null;
  cursor?: string | null;
  limit?: number;
  market?: "US";
  credentials: PokeTraceCredentials;
}): Promise<PokeTraceListPayload<PokeTraceCard>> {
  const search = new URLSearchParams();
  search.set("limit", String(Math.max(1, Math.min(params.limit ?? 20, 20))));
  search.set("market", params.market ?? "US");
  if (params.setSlug) search.set("set", params.setSlug);
  if (params.cursor) search.set("cursor", params.cursor);
  return fetchPokeTraceJson<PokeTraceListPayload<PokeTraceCard>>("/cards", search, params.credentials);
}
