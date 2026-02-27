export type WatchCertEntry = {
  cert: string;
  label: string;
  grade: string;
  updatedAt: string;
};

export type WatchCardEntry = {
  slug: string;
  canonical_name: string;
  set_name: string;
  year: number | null;
  updatedAt: string;
};

type WatchlistState = {
  certs: WatchCertEntry[];
  cards: WatchCardEntry[];
};

const STORAGE_KEY = "popalpha_watchlist_v2";

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(): WatchlistState {
  return { certs: [], cards: [] };
}

export function readWatchlist(): WatchlistState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<WatchlistState>;
    return {
      certs: Array.isArray(parsed.certs) ? parsed.certs : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
    };
  } catch {
    return emptyState();
  }
}

export function writeWatchlist(state: WatchlistState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function toggleWatchCert(entry: Omit<WatchCertEntry, "updatedAt">): WatchlistState {
  const state = readWatchlist();
  const exists = state.certs.some((item) => item.cert === entry.cert);
  const certs = exists
    ? state.certs.filter((item) => item.cert !== entry.cert)
    : [{ ...entry, updatedAt: nowIso() }, ...state.certs];
  const next = { ...state, certs };
  writeWatchlist(next);
  return next;
}

export function toggleWatchCard(entry: Omit<WatchCardEntry, "updatedAt">): WatchlistState {
  const state = readWatchlist();
  const exists = state.cards.some((item) => item.slug === entry.slug);
  const cards = exists
    ? state.cards.filter((item) => item.slug !== entry.slug)
    : [{ ...entry, updatedAt: nowIso() }, ...state.cards];
  const next = { ...state, cards };
  writeWatchlist(next);
  return next;
}

export function removeWatchCert(cert: string): WatchlistState {
  const state = readWatchlist();
  const next = { ...state, certs: state.certs.filter((item) => item.cert !== cert) };
  writeWatchlist(next);
  return next;
}

export function removeWatchCard(slug: string): WatchlistState {
  const state = readWatchlist();
  const next = { ...state, cards: state.cards.filter((item) => item.slug !== slug) };
  writeWatchlist(next);
  return next;
}

export function watchlistCount(state: WatchlistState): number {
  return state.certs.length + state.cards.length;
}

