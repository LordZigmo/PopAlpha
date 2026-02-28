/**
 * JustTCG API client (Enterprise).
 *
 * Enterprise: 500K monthly / 50K daily / 500 per minute.
 * Base URL: https://api.justtcg.com/v1
 * Auth: x-api-key header
 *
 * Known issue: /sets?game=pokemon returns INTERNAL_SERVER_ERROR.
 * Use /cards?set={provider_set_id} directly.
 * Set ID convention: setNameToJustTcgId(set_name) → e.g. "base-set-pokemon"
 */

import type { MetricsSnapshot, PriceHistoryPoint } from "./types";

const BASE_URL = "https://api.justtcg.com/v1";

function apiKey(): string {
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) throw new Error("JUSTTCG_API_KEY env var not set");
  return key;
}

// ── Raw fetch ─────────────────────────────────────────────────────────────────

/** Returns { status, body } — caller decides whether to throw on non-200. */
export async function jtFetchRaw(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-api-key": apiKey() },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function jtFetch<T>(path: string): Promise<T> {
  const { status, body } = await jtFetchRaw(path);
  if (status < 200 || status >= 300) {
    const msg = (body as Record<string, string>)?.error ?? String(body).slice(0, 200);
    throw new Error(`JustTCG ${status}: ${msg}`);
  }
  return body as T;
}

// ── Types (raw provider responses — do NOT export beyond this file's consumers) ──

export type JustTcgSet = {
  id: string;
  name: string;
  game?: string;
  cardCount?: number;
  releaseDate?: string;
};

type JustTcgPricePoint = {
  p: number;  // price
  t: number;  // unix timestamp (seconds)
};

export type JustTcgVariant = {
  id: string;
  condition: string;        // "Near Mint", "Lightly Played", ...
  printing: string;         // "Normal", "Holofoil", "Reverse Holofoil", ...
  language?: string;
  tcgplayerSkuId?: string;
  price: number;
  lastUpdated?: number;     // unix timestamp
  priceChange24hr?: number;
  priceChange7d?: number;
  priceChange30d?: number;
  priceChange90d?: number;
  // 7-day stats
  avgPrice?: number;
  minPrice7d?: number;
  maxPrice7d?: number;
  stddevPopPrice7d?: number;
  covPrice7d?: number;
  iqrPrice7d?: number;
  trendSlope7d?: number;
  priceChangesCount7d?: number;
  // 30-day stats
  avgPrice30d?: number;
  minPrice30d?: number;
  maxPrice30d?: number;
  stddevPopPrice30d?: number;
  covPrice30d?: number;
  iqrPrice30d?: number;
  trendSlope30d?: number;
  priceChangesCount30d?: number;
  priceRelativeTo30dRange?: number;
  // 90-day stats
  avgPrice90d?: number;
  minPrice90d?: number;
  maxPrice90d?: number;
  stddevPopPrice90d?: number;
  covPrice90d?: number;
  trendSlope90d?: number;
  priceChangesCount90d?: number;
  priceRelativeTo90dRange?: number;
  // All-time
  minPrice1y?: number;
  maxPrice1y?: number;
  minPriceAllTime?: number;
  minPriceAllTimeDate?: string;
  maxPriceAllTime?: number;
  maxPriceAllTimeDate?: string;
  // History arrays
  priceHistory?: JustTcgPricePoint[];
  priceHistory30d?: JustTcgPricePoint[];
};

export type JustTcgCard = {
  id: string;
  name: string;
  number: string;
  set: string;
  set_name?: string;
  rarity?: string;
  tcgplayerId?: string;
  details?: unknown;
  variants: JustTcgVariant[];
};

type CardsEnvelope = {
  data?: JustTcgCard[];
  meta?: { total: number; limit: number; offset: number; hasMore: boolean };
  _metadata?: {
    apiRequestsUsed: number;
    apiDailyRequestsUsed: number;
    apiRequestsRemaining: number;
    apiDailyRequestsRemaining: number;
    apiPlan: string;
  };
};

// ── API calls ─────────────────────────────────────────────────────────────────

/** Fetch one page of cards for a JustTCG set (up to 250 per page). */
export async function fetchJustTcgCards(
  setId: string,
  page = 1,
): Promise<{ cards: JustTcgCard[]; hasMore: boolean; rawEnvelope: unknown; httpStatus: number }> {
  const path = `/cards?set=${encodeURIComponent(setId)}&page=${page}&limit=200`;
  const { status, body } = await jtFetchRaw(path);
  if (status < 200 || status >= 300) {
    return { cards: [], hasMore: false, rawEnvelope: body, httpStatus: status };
  }
  const envelope = body as CardsEnvelope;
  const cards = envelope.data ?? [];
  const hasMore = envelope.meta?.hasMore ?? false;
  return { cards, hasMore, rawEnvelope: body, httpStatus: status };
}

// ── Set ID derivation ─────────────────────────────────────────────────────────

/**
 * Derive JustTCG's set ID from our canonical set_name.
 * Convention confirmed from API: "Base Set" → "base-set-pokemon",
 * "Arceus" → "arceus-pokemon".
 *
 * Algorithm: lowercase, replace non-alphanumeric runs with hyphens,
 * trim edge hyphens, append "-pokemon".
 */
export function setNameToJustTcgId(setName: string): string {
  return (
    setName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") + "-pokemon"
  );
}

// ── Value mapping ─────────────────────────────────────────────────────────────

/** Map JustTCG printing name → our finish enum. */
export function mapJustTcgPrinting(printing: string): string {
  const p = printing.toLowerCase();
  if (p.includes("reverse")) return "REVERSE_HOLO";
  if (p.includes("holo")) return "HOLO";
  return "NON_HOLO";
}

/** Normalize a card number: "004/130" → "4", "SWSH001" → "SWSH001". */
export function normalizeCardNumber(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/^#/, "");
  const slashMatch = trimmed.match(/^(\d+)\//);
  if (slashMatch) return String(parseInt(slashMatch[1], 10));
  return trimmed;
}

// ── Internal DTO mapping ──────────────────────────────────────────────────────

// Condition abbreviation map — must cover all JustTCG condition strings.
const CONDITION_ABBREV: Record<string, string> = {
  "near mint":        "nm",
  "lightly played":   "lp",
  "moderately played":"mp",
  "heavily played":   "hp",
  "damaged":          "dmg",
};

/**
 * Build a stable, lowercase variant_ref string from finish + condition + grade.
 * e.g. "holo:nm:raw", "reverse_holo:lp:raw"
 *
 * Rules:
 *   - finish:    lowercase, underscores preserved (e.g. "reverse_holo")
 *   - condition: mapped to standard abbreviation (see CONDITION_ABBREV); falls
 *                back to lowercase-no-spaces if no abbreviation exists
 *   - grade:     lowercase (e.g. "raw")
 *
 * This is the dedup key for price_history_points and avoids depending on
 * printing_id FK existence.
 */
export function buildVariantRef(finish: string, condition: string, grade: string): string {
  const finishNorm = finish.toLowerCase();
  const conditionKey = condition.toLowerCase().trim().replace(/\s+/g, " ");
  const conditionNorm = CONDITION_ABBREV[conditionKey] ?? conditionKey.replace(/\s+/g, "");
  const gradeNorm = grade.toLowerCase();
  return `${finishNorm}:${conditionNorm}:${gradeNorm}`;
}

/**
 * Map a JustTCG variant to our MetricsSnapshot DTO.
 * Returns null if the variant has no usable price.
 */
export function mapVariantToMetrics(
  variant: JustTcgVariant,
  canonical_slug: string,
  printing_id: string | null,
  grade: string,
  asOfTs: string,
): MetricsSnapshot | null {
  if (!variant.price || variant.price <= 0) return null;

  // Prefer provider's cov; fall back to stddev/price if cov absent.
  // COV is stored as a ratio (e.g. 0.12), NOT a percentage (e.g. 12).
  // The provider already returns covPrice* as a ratio; the fallback computes it the same way.
  const provider_cov_price_30d =
    variant.covPrice30d != null
      ? variant.covPrice30d
      : variant.stddevPopPrice30d != null && variant.price > 0
        ? parseFloat((variant.stddevPopPrice30d / variant.price).toFixed(4))
        : null;

  const provider_cov_price_7d =
    variant.covPrice7d != null
      ? variant.covPrice7d
      : variant.stddevPopPrice7d != null && variant.price > 0
        ? parseFloat((variant.stddevPopPrice7d / variant.price).toFixed(4))
        : null;

  return {
    canonical_slug,
    printing_id,
    grade,
    provider: "JUSTTCG",
    provider_as_of_ts: asOfTs,
    price_value: variant.price,
    provider_trend_slope_7d: variant.trendSlope7d ?? null,
    provider_trend_slope_30d: variant.trendSlope30d ?? null,
    provider_cov_price_7d,
    provider_cov_price_30d,
    provider_price_relative_to_30d_range: variant.priceRelativeTo30dRange ?? null,
    provider_min_price_all_time: variant.minPriceAllTime ?? null,
    provider_min_price_all_time_date: variant.minPriceAllTimeDate ?? null,
    provider_max_price_all_time: variant.maxPriceAllTime ?? null,
    provider_max_price_all_time_date: variant.maxPriceAllTimeDate ?? null,
  };
}

/**
 * Map a variant's price history arrays to PriceHistoryPoint DTOs.
 * Unix timestamps (seconds) → ISO 8601. variant_ref is stable text key.
 *
 * Prefers priceHistory30d (source_window: "30d"). Falls back to priceHistory
 * (source_window: "all") so source_window always reflects the actual window
 * rather than relying on the SQL column default.
 */
export function mapVariantToHistoryPoints(
  variant: JustTcgVariant,
  canonical_slug: string,
  finish: string,
  grade: string,
): PriceHistoryPoint[] {
  const use30d = (variant.priceHistory30d?.length ?? 0) > 0;
  const history = use30d ? variant.priceHistory30d! : (variant.priceHistory ?? []);
  const sourceWindow = use30d ? "30d" : "all";
  const variantRef = buildVariantRef(finish, variant.condition, grade);
  return history
    .filter((pt) => pt.p > 0)
    .map((pt) => ({
      canonical_slug,
      variant_ref: variantRef,
      provider: "JUSTTCG",
      ts: new Date(pt.t * 1000).toISOString(),
      price: pt.p,
      currency: "USD",
      source_window: sourceWindow,
    }));
}

// ── Legacy helpers (kept for backward compat) ─────────────────────────────────

export function normalizeSetNameForMatch(name: string): string {
  return name
    .replace(/^[A-Za-z]{1,4}\d*[A-Za-z]*\s*:\s*/u, "")
    .toLowerCase()
    .replace(/[—–]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreSetNameMatch(justTcgName: string, ourName: string): number {
  const a = normalizeSetNameForMatch(justTcgName);
  const b = normalizeSetNameForMatch(ourName);
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

export function bestSetMatch(
  justTcgSetName: string,
  candidates: Array<{ setCode: string; setName: string }>,
): { setCode: string; setName: string; score: number } | null {
  const THRESHOLD = 60;
  let best: { setCode: string; setName: string; score: number } | null = null;
  for (const c of candidates) {
    const score = scoreSetNameMatch(justTcgSetName, c.setName);
    if (score >= THRESHOLD && (!best || score > best.score)) {
      best = { ...c, score };
    }
  }
  return best;
}
