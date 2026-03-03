"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

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

function timeAgo(iso: string | null): string {
  if (!iso) return "just now";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function LiveActivityFeed() {
  const [cards, setCards] = useState<LiveActivityCard[]>([]);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/cards/live-activity", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as LiveActivityResponse;
        if (!response.ok || cancelled) return;
        setCards(payload.cards ?? []);
      })
      .catch(() => {
        if (!cancelled) setCards([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const loopedCards = useMemo(() => {
    if (cards.length === 0) return [];
    return cards.length > 1 ? [...cards, ...cards] : cards;
  }, [cards]);

  return (
    <div className="mt-4 rounded-[1.35rem] border border-[#1E1E1E] bg-[#101010] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6B6B6B]">Live Activity</p>
        <span className="h-2 w-2 rounded-full bg-[#38BDF8]" />
      </div>

      <div className="mt-3 h-[168px] overflow-hidden">
        {cards.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-[1rem] border border-dashed border-white/[0.06] text-[12px] text-[#666]">
            No recent scans yet
          </div>
        ) : (
          <motion.div
            className="space-y-2"
            animate={cards.length > 1 ? { y: [0, -(cards.length * 42)] } : undefined}
            transition={
              cards.length > 1
                ? { duration: Math.max(8, cards.length * 3.2), repeat: Number.POSITIVE_INFINITY, ease: "linear" }
                : undefined
            }
          >
            {loopedCards.map((card, index) => (
              <Link
                key={`${card.slug}-${index}`}
                href={`/c/${encodeURIComponent(card.slug)}`}
                className="flex h-10 items-center justify-between gap-3 rounded-[0.95rem] border border-white/[0.03] bg-[#0B0B0B] px-3 transition hover:border-white/[0.08]"
              >
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold text-white">{card.name}</p>
                  <p className="truncate text-[11px] text-[#666]">{card.set_name ?? "Unknown set"}</p>
                </div>
                <span className="shrink-0 text-[11px] text-[#7C8796]">{timeAgo(card.last_viewed_at)}</span>
              </Link>
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}
