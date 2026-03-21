"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSafeUser } from "@/lib/auth/use-safe-user";
import { motion } from "framer-motion";

type LiveFeedItem = {
  href: string;
  title: string;
  detail: string;
  at: string | null;
};

type LiveActivityResponse = {
  ok: boolean;
  cards: Array<{
    slug: string;
    name: string;
    set_name: string | null;
    total_views: number;
    last_viewed_at: string | null;
  }>;
};

const MOCK_EVENTS: LiveFeedItem[] = [
  {
    href: "/c/prismatic-evolutions-161-umbreon-ex",
    title: "User_X just added Umbreon ex to Watchlist",
    detail: "Prismatic Evolutions",
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    href: "/c/sv-promo-xy-mew-ex",
    title: "User_Y predicted a +5% move on Mew ex",
    detail: "Fresh community signal",
    at: new Date(Date.now() - 11 * 60_000).toISOString(),
  },
  {
    href: "/c/151-199-charizard-ex",
    title: "User_Z just checked Charizard ex",
    detail: "151",
    at: new Date(Date.now() - 19 * 60_000).toISOString(),
  },
];

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
  const { user } = useSafeUser();
  const [events, setEvents] = useState<LiveFeedItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/cards/live-activity", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as LiveActivityResponse;
        if (!response.ok || cancelled) return;
        const nextCards = payload.cards ?? [];
        if (nextCards.length > 0) {
          setEvents(nextCards.slice(0, 4).map((card) => ({
            href: `/c/${encodeURIComponent(card.slug)}`,
            title: `A collector just checked ${card.name}`,
            detail: card.set_name ?? "Market activity",
            at: card.last_viewed_at,
          })));
        } else {
          setEvents(MOCK_EVENTS);
        }
      })
      .catch(() => {
        if (!cancelled) setEvents(MOCK_EVENTS);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const loopedEvents = useMemo(() => {
    if (events.length === 0) return [];
    return events.length > 1 ? [...events, ...events] : events;
  }, [events]);

  const feedContent = events.length === 0 ? (
    <div className="flex h-full items-center justify-center rounded-[1rem] border border-dashed border-white/[0.06] text-[12px] text-[#666]">
      No recent activity yet
    </div>
  ) : (
    <motion.div
      className="space-y-2"
      animate={events.length > 1 ? { y: [0, -(events.length * 50)] } : undefined}
      transition={
        events.length > 1
          ? { duration: Math.max(10, events.length * 3.4), repeat: Number.POSITIVE_INFINITY, ease: "linear" }
          : undefined
      }
    >
      {loopedEvents.map((event, index) => (
        <Link
          key={`${event.href}-${index}`}
          href={event.href}
          className="flex min-h-12 items-center justify-between gap-3 rounded-[0.95rem] border border-white/[0.03] bg-[#0B0B0B] px-3 py-2 transition hover:border-white/[0.08]"
        >
          <div className="min-w-0">
            <p className="truncate text-[12px] font-semibold text-white">{event.title}</p>
            <p className="truncate text-[11px] text-[#666]">{event.detail}</p>
          </div>
          <span className="shrink-0 text-[11px] text-[#7C8796]">{timeAgo(event.at)}</span>
        </Link>
      ))}
    </motion.div>
  );

  return (
    <div className="relative mt-4 overflow-hidden rounded-[1.35rem] border border-[#1E1E1E] bg-[#101010] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6B6B6B]">Live Feed</p>
        <span className="h-2 w-2 rounded-full bg-[#38BDF8]" />
      </div>

      {!user ? (
        <div className="pointer-events-none absolute inset-x-4 top-1/2 z-10 flex -translate-y-1/2 justify-center">
          <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-[1.2rem] border border-white/10 bg-[#090909]/88 px-5 py-5 text-center shadow-[0_18px_45px_rgba(0,0,0,0.35)] backdrop-blur-md">
            <p className="max-w-[13rem] text-[12px] font-medium leading-5 text-[#CFCFCF]">
              Sign up to follow live collector activity as it happens.
            </p>
            <Link
              href="/sign-up"
              className="rounded-2xl border border-white bg-white px-4 py-2 text-[12px] font-bold tracking-[0.08em] text-[#0A0A0A] transition hover:opacity-90"
            >
              SIGN UP
            </Link>
          </div>
        </div>
      ) : null}

      <div className="relative mt-3 h-[168px] overflow-hidden">
        {!user ? (
          <div
            aria-hidden="true"
            className="pointer-events-none h-full select-none blur-[5px] opacity-45 saturate-50"
          >
            {feedContent}
          </div>
        ) : (
          feedContent
        )}
      </div>
    </div>
  );
}
