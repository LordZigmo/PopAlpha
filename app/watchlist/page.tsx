"use client";

import Link from "next/link";
import { useState } from "react";
import {
  listCards,
  listCerts,
  removeCard,
  removeCert,
  watchlistCount,
  type WatchCardEntry,
  type WatchCertEntry,
} from "@/lib/watchlist";

export default function WatchlistPage() {
  const [cards, setCards] = useState<WatchCardEntry[]>(() => listCards());
  const [certs, setCerts] = useState<WatchCertEntry[]>(() => listCerts());

  function refresh() {
    setCards(listCards());
    setCerts(listCerts());
  }

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <h1 className="text-app text-2xl font-semibold tracking-tight">Watchlist</h1>
          <p className="text-muted mt-2 text-sm">Saved cards and certs for quick drill-in.</p>
          <p className="text-muted mt-1 text-xs">Total watched: {watchlistCount()}</p>
        </section>

        <section className="mt-5 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Cards</p>
          {cards.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No watchlisted cards yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {cards.map((card) => (
                <li key={`${card.slug}-${card.updatedAt}`} className="flex items-center justify-between gap-2 rounded-[var(--radius-input)] border-app border p-2">
                  <Link href={`/c/${encodeURIComponent(card.slug)}`} className="min-w-0 flex-1">
                    <p className="text-app truncate text-sm font-semibold">{card.canonical_name}</p>
                    <p className="text-muted truncate text-xs">{card.year ? `${card.year} • ` : ""}{card.set_name || ""}</p>
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      removeCard(card.slug);
                      refresh();
                    }}
                    className="btn-ghost rounded-[var(--radius-input)] border px-2 py-1 text-xs"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Certs</p>
          {certs.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No watchlisted certs yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {certs.map((cert) => (
                <li key={`${cert.cert}-${cert.updatedAt}`} className="flex items-center justify-between gap-2 rounded-[var(--radius-input)] border-app border p-2">
                  <Link href={`/cert/${encodeURIComponent(cert.cert)}`} className="min-w-0 flex-1">
                    <p className="text-app truncate text-sm font-semibold">Cert #{cert.cert}</p>
                    <p className="text-muted truncate text-xs">{cert.label || "Untitled cert"}{cert.grade ? ` • ${cert.grade}` : ""}</p>
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      removeCert(cert.cert);
                      refresh();
                    }}
                    className="btn-ghost rounded-[var(--radius-input)] border px-2 py-1 text-xs"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
