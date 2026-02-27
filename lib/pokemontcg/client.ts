import { getRequiredEnv } from "@/lib/env";

const BASE_URL = "https://api.pokemontcg.io/v2";

export type PokemonTcgSet = {
  id: string;
  name: string;
  releaseDate?: string;
};

export type PokemonTcgCard = {
  id: string;
  name: string;
  number: string;
  rarity?: string;
  supertype?: string;
  subtypes?: string[];
  types?: string[];
  set: {
    id: string;
    name: string;
    releaseDate?: string;
  };
  images?: {
    small?: string;
    large?: string;
  };
  tcgplayer?: {
    prices?: Record<string, unknown>;
  };
};

type ApiListResponse<T> = {
  data: T[];
  page: number;
  pageSize: number;
  count: number;
  totalCount: number;
};

function jitteredBackoffMs(attempt: number): number {
  const base = Math.min(5000, 400 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 220);
  return base + jitter;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class PokemonTcgClient {
  private readonly apiKey: string;

  constructor() {
    this.apiKey = getRequiredEnv("POKEMONTCG_API_KEY");
  }

  private async requestJson<T>(path: string, params: URLSearchParams, attempt = 0): Promise<T> {
    const query = params.toString();
    const url = `${BASE_URL}${path}${query ? `?${query}` : ""}`;
    const response = await fetch(url, {
      headers: {
        "X-Api-Key": this.apiKey,
      },
      cache: "no-store",
    });

    if (response.status === 429) {
      if (attempt >= 6) {
        throw new Error(`PokemonTCG API rate limited after retries: ${url}`);
      }
      await sleep(jitteredBackoffMs(attempt));
      return this.requestJson<T>(path, params, attempt + 1);
    }

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`PokemonTCG API error ${response.status}: ${message}`);
    }

    return (await response.json()) as T;
  }

  async fetchSets(): Promise<PokemonTcgSet[]> {
    const params = new URLSearchParams();
    params.set("select", "id,name,releaseDate");
    const payload = await this.requestJson<ApiListResponse<PokemonTcgSet>>("/sets", params);
    return payload.data ?? [];
  }

  async fetchCardsPage(page: number, pageSize: number): Promise<ApiListResponse<PokemonTcgCard>> {
    const params = new URLSearchParams();
    params.set("pageSize", String(pageSize));
    params.set("page", String(page));
    params.set("select", "id,name,number,rarity,supertype,subtypes,types,set,images,tcgplayer");
    return this.requestJson<ApiListResponse<PokemonTcgCard>>("/cards", params);
  }
}

