/**
 * Pokemon TCG API client (RapidAPI — Ultra tier).
 *
 * Provides graded card valuations from Cardmarket for PSA, BGS, and CGC
 * across 174 sets.
 *
 * Ultra tier: 15,000 req/day, 300 req/min.
 * Host: pokemon-tcg-api.p.rapidapi.com
 * Auth: x-rapidapi-host + x-rapidapi-key headers
 */

const HOST = "pokemon-tcg-api.p.rapidapi.com";
const BASE_URL = `https://${HOST}`;

function apiKey(): string {
  const key = process.env.POKEMON_TCG_API_KEY;
  if (!key) throw new Error("POKEMON_TCG_API_KEY env var not set");
  return key;
}

// ── Rate limiter (200ms between requests → 300/min) ─────────────────────────

let lastRequestTime = 0;
const MIN_INTERVAL_MS = 200;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();

  return fetch(url, {
    headers: {
      "x-rapidapi-host": HOST,
      "x-rapidapi-key": apiKey(),
    },
    cache: "no-store",
  });
}

// ── Raw fetch ────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<{ status: number; body: T | null }> {
  const res = await rateLimitedFetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body as T | null };
}

// ── Types ────────────────────────────────────────────────────────────────────

export type PtcgApiEpisode = {
  id: number;
  name: string;
  slug: string;
  code: string | null;
  card_count: number;
};

type EpisodesEnvelope = {
  data: PtcgApiEpisode[];
  links?: { next?: string | null };
  meta?: { current_page: number; last_page: number; total: number };
};

export type PtcgApiGradedPrices = {
  psa?: { psa10?: number; psa9?: number; psa8?: number };
  bgs?: { bgs10pristine?: number; bgs10?: number; bgs9?: number; bgs8?: number };
  cgc?: { cgc10?: number; cgc9?: number; cgc8?: number };
};

export type PtcgApiCardPrices = {
  cardmarket?: {
    lowest_near_mint?: number;
    "30d_average"?: number;
    "7d_average"?: number;
    graded?: PtcgApiGradedPrices;
  };
};

export type PtcgApiCard = {
  id: number;
  tcgid: string;
  name: string;
  card_number: string | number;
  rarity: string | null;
  prices: PtcgApiCardPrices | null;
  episode?: {
    id: number;
    slug: string;
    code: string | null;
  };
};

type CardsEnvelope = {
  data: PtcgApiCard[];
  links?: { next?: string | null };
  meta?: { current_page: number; last_page: number; total: number };
};

// ── Grade mapping ────────────────────────────────────────────────────────────

type GradedProvider = "PSA" | "BGS" | "CGC";
type GradeBucket = "G8" | "G9" | "G10";

export type ExtractedGradedPrice = {
  provider: GradedProvider;
  grade: GradeBucket;
  price: number;
};

const GRADE_KEY_MAP: Record<string, { provider: GradedProvider; grade: GradeBucket }> = {
  psa10:         { provider: "PSA", grade: "G10" },
  psa9:          { provider: "PSA", grade: "G9" },
  psa8:          { provider: "PSA", grade: "G8" },
  bgs10pristine: { provider: "BGS", grade: "G10" },
  bgs10:         { provider: "BGS", grade: "G10" },
  bgs9:          { provider: "BGS", grade: "G9" },
  bgs8:          { provider: "BGS", grade: "G8" },
  cgc10:         { provider: "CGC", grade: "G10" },
  cgc9:          { provider: "CGC", grade: "G9" },
  cgc8:          { provider: "CGC", grade: "G8" },
};

/**
 * Extract graded prices from a Pokemon TCG API card response.
 * Returns an array of { provider, grade, price } entries with valid prices.
 *
 * For BGS, bgs10pristine takes priority over bgs10 (both map to G10).
 */
export function extractGradedPrices(card: PtcgApiCard): ExtractedGradedPrice[] {
  const graded = card.prices?.cardmarket?.graded;
  if (!graded) return [];

  const results: ExtractedGradedPrice[] = [];
  const seen = new Set<string>();

  // Process in a deterministic order with pristine variants first
  const allEntries: Array<[string, number | undefined]> = [];
  if (graded.bgs) {
    // bgs10pristine first so it wins over bgs10 for the G10 slot
    if (graded.bgs.bgs10pristine != null) allEntries.push(["bgs10pristine", graded.bgs.bgs10pristine]);
    if (graded.bgs.bgs10 != null) allEntries.push(["bgs10", graded.bgs.bgs10]);
    if (graded.bgs.bgs9 != null) allEntries.push(["bgs9", graded.bgs.bgs9]);
    if (graded.bgs.bgs8 != null) allEntries.push(["bgs8", graded.bgs.bgs8]);
  }
  if (graded.psa) {
    if (graded.psa.psa10 != null) allEntries.push(["psa10", graded.psa.psa10]);
    if (graded.psa.psa9 != null) allEntries.push(["psa9", graded.psa.psa9]);
    if (graded.psa.psa8 != null) allEntries.push(["psa8", graded.psa.psa8]);
  }
  if (graded.cgc) {
    if (graded.cgc.cgc10 != null) allEntries.push(["cgc10", graded.cgc.cgc10]);
    if (graded.cgc.cgc9 != null) allEntries.push(["cgc9", graded.cgc.cgc9]);
    if (graded.cgc.cgc8 != null) allEntries.push(["cgc8", graded.cgc.cgc8]);
  }

  for (const [key, price] of allEntries) {
    if (price == null || price <= 0) continue;
    const mapping = GRADE_KEY_MAP[key];
    if (!mapping) continue;

    const dedup = `${mapping.provider}:${mapping.grade}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    results.push({ provider: mapping.provider, grade: mapping.grade, price });
  }

  return results;
}

// ── API calls ────────────────────────────────────────────────────────────────

/**
 * Fetch one page of episodes (sets) from the Pokemon TCG API.
 * 20 per page, ~174 total (9 pages).
 */
export async function fetchEpisodes(
  page = 1,
): Promise<{ episodes: PtcgApiEpisode[]; hasMore: boolean; httpStatus: number }> {
  const { status, body } = await apiFetch<EpisodesEnvelope>(`/episodes?page=${page}`);
  if (status < 200 || status >= 300 || !body) {
    return { episodes: [], hasMore: false, httpStatus: status };
  }
  const episodes = body.data ?? [];
  // API doesn't always return links/meta — infer hasMore from full page (20 items)
  const hasMore = episodes.length >= 20;
  return { episodes, hasMore, httpStatus: status };
}

/**
 * Fetch all episodes from the API (paginating through all pages).
 */
export async function fetchAllEpisodes(): Promise<PtcgApiEpisode[]> {
  const all: PtcgApiEpisode[] = [];
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const { episodes, hasMore, httpStatus } = await fetchEpisodes(page);
    if (httpStatus < 200 || httpStatus >= 300) break;
    all.push(...episodes);
    if (!hasMore || episodes.length === 0) break;
    page++;
  }

  return all;
}

/**
 * Fetch one page of cards for an episode (set).
 * 20 per page; includes price data with graded valuations.
 */
export async function fetchEpisodeCards(
  episodeId: number,
  page = 1,
): Promise<{ cards: PtcgApiCard[]; hasMore: boolean; httpStatus: number }> {
  const { status, body } = await apiFetch<CardsEnvelope>(
    `/episodes/${episodeId}/cards?page=${page}`,
  );
  if (status < 200 || status >= 300 || !body) {
    return { cards: [], hasMore: false, httpStatus: status };
  }
  const cards = body.data ?? [];
  // API doesn't always return links/meta — infer hasMore from full page (20 items)
  const hasMore = cards.length >= 20;
  return { cards, hasMore, httpStatus: status };
}

/**
 * Fetch ALL cards for an episode, paginating through all pages.
 */
export async function fetchAllEpisodeCards(episodeId: number): Promise<PtcgApiCard[]> {
  const all: PtcgApiCard[] = [];
  let page = 1;
  const maxPages = 50;

  while (page <= maxPages) {
    const { cards, hasMore, httpStatus } = await fetchEpisodeCards(episodeId, page);
    if (httpStatus === 429) break; // Rate limited, stop
    if (httpStatus < 200 || httpStatus >= 300) break;
    all.push(...cards);
    if (!hasMore || cards.length === 0) break;
    page++;
  }

  return all;
}

// ── Card number normalization ────────────────────────────────────────────────

/**
 * Normalize a card number from the Pokemon TCG API to match our card_printings format.
 * "004/130" → "4", "223" → "223", "SWSH001" → "SWSH1"
 */
export function normalizeCardNumber(raw: string | number | null | undefined): string {
  if (raw == null) return "";
  const trimmed = String(raw).trim().replace(/^#/, "");
  const slashMatch = trimmed.match(/^(\d+)\//);
  if (slashMatch) return String(parseInt(slashMatch[1], 10));
  if (/^\d+$/.test(trimmed)) return String(parseInt(trimmed, 10));
  // Handle prefix+digits like "SWSH001" → "SWSH1"
  const promoMatch = trimmed.match(/^([A-Za-z]+)(\d+)$/);
  if (promoMatch) {
    return `${promoMatch[1].toUpperCase()}${String(parseInt(promoMatch[2], 10))}`;
  }
  return trimmed;
}

// ── Set name matching ────────────────────────────────────────────────────────

function normalizeSetName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[—–]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreSetMatch(apiName: string, ourName: string): number {
  const a = normalizeSetName(apiName);
  const b = normalizeSetName(ourName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  const intersection = [...aTokens].filter((t) => bTokens.has(t)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  if (union === 0) return 0;
  return Math.round((intersection / union) * 70);
}

/**
 * Build a provider_ref for dedup in price_snapshots.
 * Format: "ptcgapi:{cardId}:{gradedProvider}:{grade}"
 */
export function buildProviderRef(
  cardId: number | string,
  gradedProvider: string,
  grade: string,
): string {
  return `ptcgapi:${cardId}:${gradedProvider.toLowerCase()}:${grade.toLowerCase()}`;
}
