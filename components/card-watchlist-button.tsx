"use client";

import { useMemo, useState } from "react";
import { readWatchlist, toggleWatchCard, type WatchCardEntry } from "@/lib/watchlist";

export default function CardWatchlistButton({
  slug,
  title,
  setName,
  year,
}: {
  slug: string;
  title: string;
  setName?: string | null;
  year?: number | null;
}) {
  const [cards, setCards] = useState<WatchCardEntry[]>(() => readWatchlist().cards);
  const isSaved = useMemo(() => cards.some((entry) => entry.slug === slug), [cards, slug]);

  function toggle() {
    const next = toggleWatchCard({
      slug,
      canonical_name: title,
      set_name: setName ?? "",
      year: year ?? null,
    });
    setCards(next.cards);
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
