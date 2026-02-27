"use client";

import Link from "next/link";
import { useState } from "react";

type WatchlistEntry = {
  cert: string;
  title: string;
  grade: string;
  saved_at: string;
};

const WATCHLIST_STORAGE_KEY = "popalpha_watchlist_v1";

function readWatchlist(): WatchlistEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WatchlistEntry => {
      if (!item || typeof item !== "object") return false;
      return typeof (item as WatchlistEntry).cert === "string";
    });
  } catch {
    return [];
  }
}

export default function WatchlistPage() {
  const [entries] = useState<WatchlistEntry[]>(() => readWatchlist());

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <h1 className="text-app text-2xl font-semibold tracking-tight">Watchlist</h1>
          <p className="text-muted mt-2 text-sm">Tracked certs saved from lookup.</p>
        </section>

        <section className="mt-5 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          {entries.length === 0 ? (
            <p className="text-muted text-sm">No watchlisted certs yet.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry) => (
                <li key={`${entry.cert}-${entry.saved_at}`}>
                  <Link
                    href={`/?cert=${encodeURIComponent(entry.cert)}`}
                    className="btn-ghost block rounded-[var(--radius-input)] border px-3 py-2"
                  >
                    <p className="text-app text-sm font-semibold">Cert #{entry.cert}</p>
                    <p className="text-muted text-xs">{entry.title || "Untitled cert"}{entry.grade ? ` • ${entry.grade}` : ""}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
