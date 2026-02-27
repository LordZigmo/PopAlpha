"use client";

import { useMemo, useState } from "react";
import { addCard, isSavedCard, listCards, removeCard, type WatchCardEntry } from "@/lib/watchlist";

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
  const [cards, setCards] = useState<WatchCardEntry[]>(() => listCards());
  const isSaved = useMemo(() => cards.some((entry) => entry.slug === slug), [cards, slug]);

  function toggle() {
    if (isSavedCard(slug)) {
      setCards(removeCard(slug));
      return;
    }
    setCards(
      addCard({
        slug,
        canonical_name: title,
        set_name: setName ?? "",
        year: year ?? null,
      })
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold ${isSaved ? "badge-positive" : "btn-ghost"}`}
    >
      {isSaved ? "Watching" : "Watch"}
    </button>
  );
}
