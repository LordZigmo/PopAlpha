/**
 * Pokedata.io API client.
 *
 * Pokedata provides Pokemon card pricing, population data, and historical
 * sales analytics. Requires a Platinum-tier API key.
 *
 * Base URL: https://api.pokedata.io/v1
 * Auth: x-api-key header (or Authorization: Bearer)
 * Rate limits: Varies by plan — expect ~100 req/min, ~10K/day on Platinum.
 *
 * Endpoints (from Postman collection):
 *   GET /cards?set={setId}&limit={n}&offset={n}   — cards in a set
 *   GET /cards/search?q={name}&set={setName}       — search by name
 *   GET /cards/{cardId}                            — single card detail
 *   GET /sets                                      — list all sets
 *   GET /sets/{setId}                              — single set detail
 */

import type { MetricsSnapshot, PriceHistoryPoint } from "./types";

const BASE_URL = "https://api.pokedata.io/v1";
const PROVIDER = "POKEDATA";

// ── Types ────────────────────────────────────────────────────────────────────

export type PokedataSet = {
  id: string;
  name: string;
  series?: string;
  releaseDate?: string;
  cardCount?: number;
};

export type PokedataPricePoint = {
  date: string;   // ISO date or "YYYY-MM-DD"
  price: number;
};

export type PokedataVariant = {
  id: string;
  condition: string;       // "Near Mint", "Lightly Played", etc.
  printing: string;        // "Holofoil", "Normal", "Reverse Holofoil"
  language?: string;
  price: number | null;
  lastUpdated?: string;
  priceHistory?: PokedataPricePoint[];
  // Stats
  avgPrice7d?: number;
  avgPrice30d?: number;
  minPrice30d?: number;
  maxPrice30d?: number;
  trendSlope7d?: number;
  salesVolume30d?: number;
};

export type PokedataCard = {
  id: string;
  name: string;
  number: string;
  set: string;
  setName?: string;
  rarity?: string;
  supertype?: string;    // "Pokémon", "Trainer", "Energy"
  subtypes?: string[];
  hp?: string;
  types?: string[];
  imageUrl?: string;
  variants: PokedataVariant[];
};

type CardsEnvelope = {
  data?: PokedataCard[];
  meta?: { total: number; limit: number; offset: number; hasMore: boolean };
};

type SetsEnvelope = {
  data?: PokedataSet[];
};

export type PokedataFinish = "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";

// ── Auth ─────────────────────────────────────────────────────────────────────

function apiKey(): string {
  const key = process.env.POKEDATA_API_KEY;
  if (!key) throw new Error("POKEDATA_API_KEY env var not set");
  return key;
}

// ── Rate limiter ─────────────────────────────────────────────────────────────

let lastRequestMs = 0;
const MIN_INTERVAL_MS = 650; // ~92 req/min, safely under 100/min

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestMs));
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestMs = Date.now();
  return fetch(url, {
    headers: {
      "x-api-key": apiKey(),
      Accept: "application/json",
    },
    cache: "no-store",
  });
}

// ── Raw fetch ────────────────────────────────────────────────────────────────

export async function pdFetchRaw(path: string): Promise<{ status: number; body: unknown }> {
  const res = await rateLimitedFetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function pdFetch<T>(path: string): Promise<T> {
  const { status, body } = await pdFetchRaw(path);
  if (status === 429) {
    throw new Error("Pokedata rate limit exceeded (429). Back off and retry.");
  }
  if (status < 200 || status >= 300) {
    const msg = (body as Record<string, string>)?.error ?? String(body).slice(0, 200);
    throw new Error(`Pokedata ${status}: ${msg}`);
  }
  return body as T;
}

// ── API calls ────────────────────────────────────────────────────────────────

/** Fetch one page of cards for a set. */
export async function fetchPokedataCardsPage(
  setId: string,
  options?: { limit?: number; offset?: number },
): Promise<{ cards: PokedataCard[]; hasMore: boolean; rawEnvelope: unknown; httpStatus: number }> {
  const limit = Math.max(1, Math.min(options?.limit ?? 100, 200));
  const offset = Math.max(0, options?.offset ?? 0);
  const path = `/cards?set=${encodeURIComponent(setId)}&limit=${limit}&offset=${offset}`;
  const { status, body } = await pdFetchRaw(path);
  if (status < 200 || status >= 300) {
    return { cards: [], hasMore: false, rawEnvelope: body, httpStatus: status };
  }
  const envelope = body as CardsEnvelope;
  const cards = envelope.data ?? [];
  const hasMore = envelope.meta?.hasMore ?? false;
  return { cards, hasMore, rawEnvelope: body, httpStatus: status };
}

/** Fetch all cards in a set (auto-paginate). */
export async function fetchPokedataSet(
  setId: string,
  options?: { maxPages?: number },
): Promise<{ cards: PokedataCard[]; pages: number }> {
  const maxPages = options?.maxPages ?? 50;
  const allCards: PokedataCard[] = [];
  let offset = 0;
  let pages = 0;
  const limit = 100;

  while (pages < maxPages) {
    const { cards, hasMore, httpStatus } = await fetchPokedataCardsPage(setId, { limit, offset });
    if (httpStatus < 200 || httpStatus >= 300) break;
    allCards.push(...cards);
    pages++;
    if (!hasMore || cards.length === 0) break;
    offset += limit;
  }

  return { cards: allCards, pages };
}

/** Search for a card by name (optionally scoped to a set). */
export async function searchPokedataCard(
  query: string,
  setName?: string,
): Promise<PokedataCard[]> {
  const params = new URLSearchParams({ q: query });
  if (setName) params.set("set", setName);
  const result = await pdFetch<CardsEnvelope>(`/cards/search?${params.toString()}`);
  return result.data ?? [];
}

/** Get a single card by its Pokedata ID. */
export async function fetchPokedataCard(cardId: string): Promise<PokedataCard | null> {
  const { status, body } = await pdFetchRaw(`/cards/${encodeURIComponent(cardId)}`);
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    const msg = (body as Record<string, string>)?.error ?? String(body).slice(0, 200);
    throw new Error(`Pokedata ${status}: ${msg}`);
  }
  return (body as { data?: PokedataCard }).data ?? (body as PokedataCard);
}

/** List all sets from Pokedata. */
export async function fetchPokedataSets(): Promise<PokedataSet[]> {
  const result = await pdFetch<SetsEnvelope>("/sets");
  return result.data ?? [];
}

// ── Value mapping ────────────────────────────────────────────────────────────

/** Map Pokedata printing name to our finish enum. */
export function mapPokedataPrinting(printing: string): PokedataFinish {
  const p = printing.toLowerCase().trim();
  if (/\breverse\b/.test(p)) return "REVERSE_HOLO";
  if (/\bnon[\s-]*holo/.test(p) || /\bnormal\b/.test(p) || /\bregular\b/.test(p)) return "NON_HOLO";
  if (/\bholo/.test(p) || /\bfoil\b/.test(p)) return "HOLO";
  return "UNKNOWN";
}

/** Normalize card number: "004/130" → "4". */
export function normalizeCardNumber(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/^#/, "");
  const slashMatch = trimmed.match(/^(\d+)\//);
  if (slashMatch) return String(parseInt(slashMatch[1], 10));
  if (/^\d+$/.test(trimmed)) return String(parseInt(trimmed, 10));
  return trimmed;
}

const CONDITION_ABBREV: Record<string, string> = {
  "near mint": "nm",
  "lightly played": "lp",
  "moderately played": "mp",
  "heavily played": "hp",
  "damaged": "dmg",
  "sealed": "sealed",
};

export function normalizeCondition(condition: string): string {
  const key = condition.toLowerCase().trim().replace(/\s+/g, " ");
  return CONDITION_ABBREV[key] ?? key.replace(/\s+/g, "");
}

const LANGUAGE_ABBREV: Record<string, string> = {
  english: "en",
  japanese: "jp",
  korean: "kr",
  french: "fr",
  german: "de",
  spanish: "es",
  italian: "it",
  portuguese: "pt",
};

export function normalizeLanguage(lang: string): string {
  const key = lang.toLowerCase().trim();
  return LANGUAGE_ABBREV[key] ?? key.replace(/\s+/g, "_");
}

// ── DTO mapping ──────────────────────────────────────────────────────────────

/** Map a Pokedata variant to our MetricsSnapshot DTO. */
export function mapVariantToMetrics(
  variant: PokedataVariant,
  canonical_slug: string,
  printing_id: string | null,
  grade: string,
  asOfTs: string,
): MetricsSnapshot | null {
  if (!variant.price || variant.price <= 0) return null;

  const provider_cov_price_30d =
    variant.avgPrice30d && variant.avgPrice30d > 0 && variant.minPrice30d != null && variant.maxPrice30d != null
      ? parseFloat(((variant.maxPrice30d - variant.minPrice30d) / variant.avgPrice30d).toFixed(4))
      : null;

  const provider_price_relative_to_30d_range =
    variant.minPrice30d != null && variant.maxPrice30d != null && variant.maxPrice30d > variant.minPrice30d
      ? parseFloat(((variant.price - variant.minPrice30d) / (variant.maxPrice30d - variant.minPrice30d)).toFixed(4))
      : null;

  return {
    canonical_slug,
    printing_id,
    grade,
    provider: PROVIDER,
    provider_as_of_ts: asOfTs,
    price_value: variant.price,
    provider_trend_slope_7d: variant.trendSlope7d ?? null,
    provider_trend_slope_30d: null,
    provider_cov_price_7d: null,
    provider_cov_price_30d,
    provider_price_relative_to_30d_range,
    provider_min_price_all_time: null,
    provider_max_price_all_time: null,
    provider_min_price_all_time_date: null,
    provider_max_price_all_time_date: null,
    provider_price_changes_count_30d: variant.salesVolume30d ?? null,
  };
}

/** Map a Pokedata variant's price history to PriceHistoryPoint DTOs. */
export function mapVariantToHistoryPoints(
  variant: PokedataVariant,
  canonical_slug: string,
  variantRef: string,
): PriceHistoryPoint[] {
  if (!variant.priceHistory || variant.priceHistory.length === 0) return [];

  return variant.priceHistory
    .filter((pt) => pt.price > 0 && pt.date)
    .map((pt) => {
      // Normalize date to ISO 8601
      const ts = pt.date.includes("T") ? pt.date : `${pt.date}T00:00:00.000Z`;
      return {
        canonical_slug,
        variant_ref: variantRef,
        provider: PROVIDER,
        ts,
        price: pt.price,
        currency: "USD",
        source_window: "30d" as const,
      };
    });
}
