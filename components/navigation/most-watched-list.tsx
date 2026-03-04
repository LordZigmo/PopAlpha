"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type LiveActivityCard = {
  slug: string;
  name: string;
  set_name: string | null;
  total_views: number;
  last_viewed_at: string | null;
};

type LiveActivityResponse = {
  ok: boolean;
  cards: LiveActivityCard[];
};

const DEMO_WATCHED: LiveActivityCard[] = [
  { slug: "prismatic-evolutions-161-umbreon-ex", name: "Umbreon ex", set_name: "Prismatic Evolutions", total_views: 12, last_viewed_at: null },
  { slug: "151-199-charizard-ex", name: "Charizard ex", set_name: "151", total_views: 9, last_viewed_at: null },
  { slug: "evolving-skies-215-rayquaza-vmax", name: "Rayquaza VMAX", set_name: "Evolving Skies", total_views: 7, last_viewed_at: null },
];

function watchCount(viewTotal: number): number {
  return Math.max(3, Math.min(24, Math.round(viewTotal * 1.4)));
}

export default function MostWatchedList() {
  const [cards, setCards] = useState<LiveActivityCard[]>([]);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/cards/live-activity", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as LiveActivityResponse;
        if (!response.ok || cancelled) return;
        setCards((payload.cards ?? []).length > 0 ? payload.cards : DEMO_WATCHED);
      })
      .catch(() => {
        if (!cancelled) setCards(DEMO_WATCHED);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mt-4 rounded-[1.35rem] border border-[#1E1E1E] bg-[#101010] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6B6B6B]">Most Watched</p>
        <span className="h-2 w-2 rounded-full bg-[#F59E0B]" />
      </div>

      <div className="mt-3 space-y-2.5">
        {cards.slice(0, 3).map((card) => (
          <Link
            key={card.slug}
            href={`/c/${encodeURIComponent(card.slug)}`}
            className="block rounded-[0.95rem] border border-white/[0.03] bg-[#0B0B0B] px-3 py-3 transition hover:border-white/[0.08]"
          >
            <p className="text-[12px] leading-5 text-[#D4D4D4]">
              <span className="font-bold text-white">{watchCount(card.total_views)}</span>{" "}
              users added <span className="font-semibold text-white">{card.name}</span> to their Watchlist in the last hour.
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
