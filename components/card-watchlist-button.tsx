"use client";

import { useMemo, useState } from "react";

type CardWatchlistEntry = {
  slug: string;
  title: string;
  saved_at: string;
};

const STORAGE_KEY = "popalpha_card_watchlist_v1";

function readEntries(): CardWatchlistEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CardWatchlistEntry[]) : [];
  } catch {
    return [];
  }
}

function writeEntries(entries: CardWatchlistEntry[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export default function CardWatchlistButton({ slug, title }: { slug: string; title: string }) {
  const [entries, setEntries] = useState<CardWatchlistEntry[]>(() => readEntries());
  const isSaved = useMemo(() => entries.some((entry) => entry.slug === slug), [entries, slug]);

  function toggle() {
    const next = isSaved
      ? entries.filter((entry) => entry.slug !== slug)
      : [{ slug, title, saved_at: new Date().toISOString() }, ...entries];
    setEntries(next);
    writeEntries(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold ${isSaved ? "badge-positive" : "btn-ghost"}`}
    >
      {isSaved ? "Saved" : "Add to Watchlist"}
    </button>
  );
}

