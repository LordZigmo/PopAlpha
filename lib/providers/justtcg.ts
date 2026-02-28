/**
 * JustTCG API client.
 *
 * Free Tier: 1000 monthly / 100 daily / 10 per minute.
 * Base URL: https://api.justtcg.com/v1
 * Auth: x-api-key header
 */

const BASE_URL = "https://api.justtcg.com/v1";

function apiKey(): string {
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) throw new Error("JUSTTCG_API_KEY env var not set");
  return key;
}

async function jtFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-api-key": apiKey() },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`JustTCG ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type JustTcgSet = {
  id: string;
  name: string;
  game?: string;
  cardCount?: number;
  releaseDate?: string;
};

export type JustTcgVariant = {
  id: string;
  condition: string;   // "Near Mint", "Lightly Played", "Moderately Played", …
  printing: string;    // "Normal", "Holofoil", "Reverse Holofoil", "First Edition", …
  language?: string;
  price: number;
  lastUpdated?: string;
  priceChange7d?: number;
  priceChange30d?: number;
  priceHistory?: unknown;
};

export type JustTcgCard = {
  id: string;
  name: string;
  number: string;       // e.g. "004/130"
  set: string;          // set ID
  set_name?: string;
  rarity?: string;
  tcgplayerId?: string;
  variants: JustTcgVariant[];
};

// ── API calls ─────────────────────────────────────────────────────────────────

/** Fetch all Pokemon sets from JustTCG. */
export async function fetchJustTcgSets(): Promise<JustTcgSet[]> {
  type Envelope = { sets?: JustTcgSet[]; data?: JustTcgSet[] } | JustTcgSet[];
  const raw = await jtFetch<Envelope>("/sets?game=pokemon");
  if (Array.isArray(raw)) return raw;
  const wrapped = raw as { sets?: JustTcgSet[]; data?: JustTcgSet[] };
  return wrapped.sets ?? wrapped.data ?? [];
}

/** Fetch one page of cards for a JustTCG set (up to 250 per page). */
export async function fetchJustTcgCards(
  setId: string,
  page = 1,
): Promise<{ cards: JustTcgCard[]; hasMore: boolean }> {
  type Envelope =
    | {
        cards?: JustTcgCard[];
        data?: JustTcgCard[];
        hasMore?: boolean;
        total?: number;
      }
    | JustTcgCard[];
  const raw = await jtFetch<Envelope>(
    `/cards?set=${encodeURIComponent(setId)}&page=${page}&limit=250`,
  );
  if (Array.isArray(raw)) return { cards: raw, hasMore: false };
  const wrapped = raw as {
    cards?: JustTcgCard[];
    data?: JustTcgCard[];
    hasMore?: boolean;
  };
  const cards = wrapped.cards ?? wrapped.data ?? [];
  return { cards, hasMore: !!wrapped.hasMore };
}

// ── Set name matching ─────────────────────────────────────────────────────────

/**
 * Normalize a set name for fuzzy comparison:
 *  - Strip series prefix like "SV01: " or "BW5: "
 *  - Lowercase, replace em/en dashes with space, remove non-alphanumeric
 */
export function normalizeSetNameForMatch(name: string): string {
  return name
    .replace(/^[A-Za-z]{1,4}\d*[A-Za-z]*\s*:\s*/u, "") // "SV01: " → ""
    .toLowerCase()
    .replace(/[—–]/g, " ")          // em/en dash → space
    .replace(/[^a-z0-9\s]/g, "")   // remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/** Score how well a JustTCG set name matches one of our set names. 0–100. */
export function scoreSetNameMatch(justTcgName: string, ourName: string): number {
  const a = normalizeSetNameForMatch(justTcgName);
  const b = normalizeSetNameForMatch(ourName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  // Jaccard token similarity
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  const intersection = [...aTokens].filter((t) => bTokens.has(t)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  if (union === 0) return 0;
  return Math.round((intersection / union) * 70);
}

/**
 * Find the best matching set among our candidates.
 * Returns null if no candidate scores above the threshold.
 */
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
