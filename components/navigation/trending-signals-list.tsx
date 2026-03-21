"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSafeUser } from "@/lib/auth/use-safe-user";

type SignalPayload = {
  ok: boolean;
  bullishLeader: {
    slug: string;
    name: string;
    set_name: string | null;
    up_pct: number;
    vote_count: number;
  } | null;
  mostWatched: {
    slug: string;
    name: string;
    set_name: string | null;
    add_count: number;
  } | null;
  divergence: {
    slug: string;
    name: string;
    set_name: string | null;
    total_views: number;
    vote_count: number;
  } | null;
};

type ResolvedSignals = {
  bullishLeader: NonNullable<SignalPayload["bullishLeader"]>;
  mostWatched: NonNullable<SignalPayload["mostWatched"]>;
  divergence: NonNullable<SignalPayload["divergence"]>;
};

const DEMO: ResolvedSignals = {
  bullishLeader: {
    slug: "prismatic-evolutions-161-umbreon-ex",
    name: "Umbreon ex",
    set_name: "Prismatic Evolutions",
    up_pct: 91,
    vote_count: 22,
  },
  mostWatched: {
    slug: "151-199-charizard-ex",
    name: "Charizard ex",
    set_name: "151",
    add_count: 12,
  },
  divergence: {
    slug: "sv-promo-xy-mew-ex",
    name: "Mew ex",
    set_name: "Scarlet & Violet Promo",
    total_views: 48,
    vote_count: 3,
  },
};

export default function TrendingSignalsList() {
  const { user } = useSafeUser();
  const [signals, setSignals] = useState<ResolvedSignals>(DEMO);
  const bullishLeader = signals.bullishLeader;
  const mostWatched = signals.mostWatched;
  const divergence = signals.divergence;

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/market-signals", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as SignalPayload;
        if (!response.ok || cancelled) return;
        setSignals({
          bullishLeader: payload.bullishLeader ?? DEMO.bullishLeader,
          mostWatched: payload.mostWatched ?? DEMO.mostWatched,
          divergence: payload.divergence ?? DEMO.divergence,
        });
      })
      .catch(() => {
        if (!cancelled) setSignals(DEMO);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const signalCards = (
    <div className="mt-3 space-y-2.5">
      <Link
        href={`/c/${encodeURIComponent(bullishLeader.slug)}`}
        className="block rounded-[0.95rem] border border-white/[0.03] bg-[#0B0B0B] px-3 py-3 transition hover:border-white/[0.08]"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">1. The Bullish Leader</p>
        <p className="mt-1 text-[12px] font-semibold text-white">{bullishLeader.name}</p>
        <p className="mt-1 text-[11px] text-[#8A8A8A]">{bullishLeader.set_name ?? "Community board"}</p>
        <p className="mt-1 text-[11px] text-[#8DF0B4]">{bullishLeader.up_pct}% think up across {bullishLeader.vote_count} votes</p>
      </Link>

      <Link
        href={`/c/${encodeURIComponent(mostWatched.slug)}`}
        className="block rounded-[0.95rem] border border-white/[0.03] bg-[#0B0B0B] px-3 py-3 transition hover:border-white/[0.08]"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">2. The Most Watched</p>
        <p className="mt-1 text-[12px] font-semibold text-white">{mostWatched.name}</p>
        <p className="mt-1 text-[11px] text-[#8A8A8A]">{mostWatched.set_name ?? "Watchlist surge"}</p>
        <p className="mt-1 text-[11px] text-[#D4D4D8]">{mostWatched.add_count} users added it to their watchlist in the last hour</p>
      </Link>

      <Link
        href={`/c/${encodeURIComponent(divergence.slug)}`}
        className="block rounded-[0.95rem] border border-white/[0.03] bg-[#0B0B0B] px-3 py-3 transition hover:border-white/[0.08]"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">3. The Divergence</p>
        <p className="mt-1 text-[12px] font-semibold text-white">{divergence.name}</p>
        <p className="mt-1 text-[11px] text-[#8A8A8A]">{divergence.set_name ?? "Watching, not voting"}</p>
        <p className="mt-1 text-[11px] text-[#D4D4D8]">{divergence.total_views} views, but only {divergence.vote_count} people priced a move</p>
      </Link>
    </div>
  );

  return (
    <div className="relative mt-4 overflow-hidden rounded-[1.35rem] border border-[#1E1E1E] bg-[#101010] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6B6B6B]">Trending Signals</p>
        <span className="h-2 w-2 rounded-full bg-[#8B5CF6]" />
      </div>

      {!user ? (
        <div className="pointer-events-none absolute inset-x-4 top-1/2 z-10 flex -translate-y-1/2 justify-center">
          <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-[1.2rem] border border-white/10 bg-[#090909]/88 px-5 py-5 text-center shadow-[0_18px_45px_rgba(0,0,0,0.35)] backdrop-blur-md">
            <p className="max-w-[13rem] text-[12px] font-medium leading-5 text-[#CFCFCF]">
              Sign up to unlock the live market signals collectors are watching right now.
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

      <div className="relative">
        {!user ? (
          <div
            aria-hidden="true"
            className="pointer-events-none select-none blur-[5px] opacity-45 saturate-50"
          >
            {signalCards}
          </div>
        ) : (
          signalCards
        )}
      </div>
    </div>
  );
}
