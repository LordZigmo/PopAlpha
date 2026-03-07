/**
 * Scrydex API client for Pokemon TCG data.
 * Base URL: https://api.scrydex.com/pokemon/v1/
 * Auth: X-Api-Key + X-Team-ID (both required)
 */

const BASE_URL = "https://api.scrydex.com/pokemon/v1";
const DEFAULT_TIMEOUT_MS = process.env.SCRYDEX_HTTP_TIMEOUT_MS
  ? Math.max(1000, parseInt(process.env.SCRYDEX_HTTP_TIMEOUT_MS, 10))
  : 30000;
const DEFAULT_RETRY_ATTEMPTS = process.env.SCRYDEX_HTTP_RETRY_ATTEMPTS
  ? Math.max(1, parseInt(process.env.SCRYDEX_HTTP_RETRY_ATTEMPTS, 10))
  : 4;
const DEFAULT_RETRY_BACKOFF_MS = process.env.SCRYDEX_HTTP_RETRY_BACKOFF_MS
  ? Math.max(100, parseInt(process.env.SCRYDEX_HTTP_RETRY_BACKOFF_MS, 10))
  : 1200;

export type ScrydexCredentials = {
  apiKey: string;
  teamId: string;
};

export function getScrydexCredentials(): ScrydexCredentials {
  const apiKey = process.env.SCRYDEX_API_KEY?.trim();
  const teamId = process.env.SCRYDEX_TEAM_ID?.trim();
  if (!apiKey || !teamId) {
    throw new Error(
      "Missing SCRYDEX_API_KEY or SCRYDEX_TEAM_ID. Add both to .env.local from https://scrydex.com/ dashboard."
    );
  }
  return { apiKey, teamId };
}

export type ScrydexExpansion = {
  id: string;
  name: string;
  release_date?: string;
  releaseDate?: string;
  language_code?: string;
};

export type ScrydexImage = {
  type?: string;
  small?: string;
  medium?: string;
  large?: string;
};

export type ScrydexVariant = {
  name: string;
  prices?: unknown;
  images?: ScrydexImage[];
};

export type ScrydexCard = {
  id: string;
  name: string;
  number: string;
  printed_number?: string;
  rarity?: string;
  expansion?: {
    id: string;
    name: string;
    release_date?: string;
    releaseDate?: string;
  };
  images?: ScrydexImage[];
  variants?: ScrydexVariant[];
  language_code?: string;
};

export type ScrydexListPayload<T> = {
  data: T[];
  page: number;
  pageSize: number;
  totalCount: number;
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
    || status === 504
    || status === 522
    || status === 524;
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

export async function fetchScrydexJson<T>(
  path: string,
  params: URLSearchParams,
  credentials: ScrydexCredentials
): Promise<T> {
  const url = `${BASE_URL}${path}?${params.toString()}`;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= DEFAULT_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "X-Api-Key": credentials.apiKey,
          "X-Team-ID": credentials.teamId,
        },
        cache: "no-store",
        signal: controller.signal,
      });

      if (response.ok) {
        clearTimeout(timeout);
        return (await response.json()) as T;
      }

      const body = (await response.text()).slice(0, 400);
      lastError = `Scrydex API error ${response.status}: ${body}`;
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

  throw new Error(lastError ?? "Scrydex API request failed");
}

/** Fetch English expansions (sets) with pagination. Max 100 per page. */
export async function fetchExpansionsPage(
  page: number,
  pageSize: number,
  credentials: ScrydexCredentials
): Promise<ScrydexListPayload<ScrydexExpansion>> {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("page_size", String(pageSize));
  const payload = await fetchScrydexJson<ScrydexListPayload<ScrydexExpansion>>(
    "/en/expansions",
    params,
    credentials
  );
  return payload;
}

/** Fetch English cards with pagination. Max 100 per page. */
export async function fetchCardsPage(
  page: number,
  pageSize: number,
  expansionId: string | null,
  credentials: ScrydexCredentials
): Promise<ScrydexListPayload<ScrydexCard>> {
  const path = expansionId
    ? `/en/expansions/${encodeURIComponent(expansionId)}/cards`
    : "/en/cards";
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("page_size", String(pageSize));
  // Prices are opt-in for search/list endpoints in Scrydex docs.
  params.set("include", "prices");
  const payload = await fetchScrydexJson<ScrydexListPayload<ScrydexCard>>(path, params, credentials);
  return payload;
}
