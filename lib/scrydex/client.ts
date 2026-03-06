/**
 * Scrydex API client for Pokemon TCG data.
 * Base URL: https://api.scrydex.com/pokemon/v1/
 * Auth: X-Api-Key + X-Team-ID (both required)
 */

const BASE_URL = "https://api.scrydex.com/pokemon/v1";

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

export async function fetchScrydexJson<T>(
  path: string,
  params: URLSearchParams,
  credentials: ScrydexCredentials
): Promise<T> {
  const url = `${BASE_URL}${path}?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      "X-Api-Key": credentials.apiKey,
      "X-Team-ID": credentials.teamId,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 400);
    throw new Error(`Scrydex API error ${response.status}: ${body}`);
  }

  return (await response.json()) as T;
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
  const payload = await fetchScrydexJson<ScrydexListPayload<ScrydexCard>>(path, params, credentials);
  return payload;
}
