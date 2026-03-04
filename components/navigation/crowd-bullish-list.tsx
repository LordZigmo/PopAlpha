"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type CrowdBullishCard = {
  slug: string;
  name: string;
  set_name: string | null;
  up_pct: number;
  vote_count: number;
};

type CrowdBullishResponse = {
  ok: boolean;
  cards: CrowdBullishCard[];
};

const DEMO_CARDS: CrowdBullishCard[] = [
  { slug: "prismatic-evolutions-161-umbreon-ex", name: "Umbreon ex", set_name: "Prismatic Evolutions", up_pct: 91, vote_count: 22 },
  { slug: "151-199-charizard-ex", name: "Charizard ex", set_name: "151", up_pct: 87, vote_count: 18 },
  { slug: "evolving-skies-215-rayquaza-vmax", name: "Rayquaza VMAX", set_name: "Evolving Skies", up_pct: 83, vote_count: 14 },
];

export default function CrowdBullishList() {
  const [cards, setCards] = useState<CrowdBullishCard[]>([]);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/community-pulse/crowd", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as CrowdBullishResponse;
        if (!response.ok || cancelled) return;
        setCards((payload.cards ?? []).length > 0 ? payload.cards : DEMO_CARDS);
      })
      .catch(() => {
        if (!cancelled) setCards(DEMO_CARDS);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mt-4 rounded-[1.35rem] border border-[#1E1E1E] bg-[#101010] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6B6B6B]">The Crowd Is Bullish On...</p>
        <span className="text-[11px] font-semibold text-[#8DF0B4]">80%+</span>
      </div>

      <div className="mt-3 space-y-2">
        {cards.slice(0, 3).map((card) => (
          <Link
            key={card.slug}
            href={`/c/${encodeURIComponent(card.slug)}`}
            className="flex items-center justify-between gap-3 rounded-[0.95rem] border border-white/[0.03] bg-[#0B0B0B] px-3 py-3 transition hover:border-white/[0.08]"
          >
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold text-white">{card.name}</p>
              <p className="truncate text-[11px] text-[#666]">{card.set_name ?? "Unknown set"}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[12px] font-bold text-[#8DF0B4]">{card.up_pct}% up</p>
              <p className="text-[10px] text-[#6B7280]">{card.vote_count} votes</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
