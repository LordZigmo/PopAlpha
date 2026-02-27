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

const STORAGE_KEY = "popalpha_watchlist_v1";
const LEGACY_STORAGE_KEY = "popalpha_watchlist_v2";

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(): WatchlistState {
  return { certs: [], cards: [] };
}

function sanitizeState(value: unknown): WatchlistState {
  const parsed = (value ?? {}) as Partial<WatchlistState>;
  return {
    certs: Array.isArray(parsed.certs) ? parsed.certs : [],
    cards: Array.isArray(parsed.cards) ? parsed.cards : [],
  };
}

export function readWatchlist(): WatchlistState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeState(JSON.parse(raw));
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyRaw) return emptyState();
    const migrated = sanitizeState(JSON.parse(legacyRaw));
    writeWatchlist(migrated);
    return migrated;
  } catch {
    return emptyState();
  }
}

export function writeWatchlist(state: WatchlistState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event("watchlist:changed"));
}

function withUpdatedAt<T extends Record<string, unknown>>(entry: T): T & { updatedAt: string } {
  return { ...entry, updatedAt: nowIso() };
}

export function listCerts(): WatchCertEntry[] {
  return readWatchlist().certs;
}

export function listCards(): WatchCardEntry[] {
  return readWatchlist().cards;
}

export function isSavedCert(cert: string): boolean {
  return listCerts().some((item) => item.cert === cert);
}

export function isSavedCard(slug: string): boolean {
  return listCards().some((item) => item.slug === slug);
}

export function addCert(entry: Omit<WatchCertEntry, "updatedAt">): WatchCertEntry[] {
  const state = readWatchlist();
  const certs = [
    withUpdatedAt(entry),
    ...state.certs.filter((item) => item.cert !== entry.cert),
  ];
  const next = { ...state, certs };
  writeWatchlist(next);
  return next.certs;
}

export function removeCert(cert: string): WatchCertEntry[] {
  const state = readWatchlist();
  const next = { ...state, certs: state.certs.filter((item) => item.cert !== cert) };
  writeWatchlist(next);
  return next.certs;
}

export function addCard(entry: Omit<WatchCardEntry, "updatedAt">): WatchCardEntry[] {
  const state = readWatchlist();
  const cards = [
    withUpdatedAt(entry),
    ...state.cards.filter((item) => item.slug !== entry.slug),
  ];
  const next = { ...state, cards };
  writeWatchlist(next);
  return next.cards;
}

export function removeCard(slug: string): WatchCardEntry[] {
  const state = readWatchlist();
  const next = { ...state, cards: state.cards.filter((item) => item.slug !== slug) };
  writeWatchlist(next);
  return next.cards;
}

export function watchlistCount(): number {
  const state = readWatchlist();
  return state.certs.length + state.cards.length;
}

export function toggleWatchCert(entry: Omit<WatchCertEntry, "updatedAt">): WatchlistState {
  if (isSavedCert(entry.cert)) {
    return { ...readWatchlist(), certs: removeCert(entry.cert) };
  }
  return { ...readWatchlist(), certs: addCert(entry) };
}

export function toggleWatchCard(entry: Omit<WatchCardEntry, "updatedAt">): WatchlistState {
  if (isSavedCard(entry.slug)) {
    return { ...readWatchlist(), cards: removeCard(entry.slug) };
  }
  return { ...readWatchlist(), cards: addCard(entry) };
}

export function removeWatchCert(cert: string): WatchlistState {
  return { ...readWatchlist(), certs: removeCert(cert) };
}

export function removeWatchCard(slug: string): WatchlistState {
  return { ...readWatchlist(), cards: removeCard(slug) };
}

