"use client";

import * as React from "react";
import Link from "next/link";
import { useSafeUser } from "@/lib/auth/use-safe-user";
import PricingModal from "@/components/billing/pricing-modal";
import LiveActivityFeed from "@/components/navigation/live-activity-feed";
import TrendingSignalsList from "@/components/navigation/trending-signals-list";
import ElitePromo from "@/components/sidebar/ElitePromo";
import TypewriterText from "@/components/typewriter-text";
import { Sparkles } from "lucide-react";

export default function DesktopSidebar() {
  const [pricingOpen, setPricingOpen] = React.useState(false);
  const { user } = useSafeUser();
  const content = (
    <>
      <div className="mb-6 flex items-center justify-between gap-3">
        <p className="text-[18px] font-semibold tracking-[-0.03em] text-white">PopAlpha</p>
        {!user ? (
          <Link
            href="/sign-up"
            className="rounded-2xl border px-3.5 py-2 text-[12px] font-bold tracking-[0.08em] transition hover:opacity-90"
            style={{ backgroundColor: "#FFFFFF", color: "#0A0A0A", borderColor: "#FFFFFF" }}
          >
            SIGN UP
          </Link>
        ) : null}
      </div>

      <section className="relative shrink-0 overflow-hidden rounded-[1.7rem] border border-[#63D471]/25 border-l-4 border-l-emerald-500 bg-emerald-500/10 px-5 py-5 shadow-[0_0_28px_rgba(16,185,129,0.12)] backdrop-blur-md">
        <span className="pointer-events-none absolute inset-y-0 -left-1 w-1/2 scout-holo-shimmer" aria-hidden="true" />
        <div className="relative z-10 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[23px] font-semibold tracking-[-0.03em] text-emerald-400">
              <Sparkles size={13} strokeWidth={2.2} className="text-emerald-300" />
              PopAlpha Scout
            </div>
            <p className="mt-1 text-[11px] font-medium tracking-[0.04em] text-emerald-200/85">
              Pokémon-obsessed AI
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end">
            <span className="inline-flex h-[2rem] items-center gap-2 self-start rounded-full border border-red-500/20 bg-red-500/10 px-2.5 text-[15px] font-semibold leading-none tracking-[-0.01em] text-red-100">
              <span className="relative flex h-3 w-3 items-center justify-center">
                <span className="absolute inline-flex h-3 w-3 rounded-full bg-red-500 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
              </span>
              Live
            </span>
            <span className="mt-1 pr-1 text-[10px] font-medium tracking-[0.04em] text-emerald-200/75">
              just now
            </span>
          </div>
        </div>
        <TypewriterText
          text="A few chase cards are still getting most of the attention, so the market feels focused instead of fully heated."
          className="relative z-10 mt-4 text-[15px] font-medium leading-relaxed text-emerald-50"
        />
      </section>

      <TrendingSignalsList />
      <LiveActivityFeed />

      <ElitePromo onClick={() => setPricingOpen(true)} />

      <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} />
    </>
  );

  return (
    <aside className="fixed inset-y-0 right-0 z-40 hidden w-80 md:flex">
      <div className="sticky top-0 flex h-screen w-full flex-col overflow-y-auto border-l border-[#1E1E1E] bg-[#0A0A0A]/95 px-5 py-6 backdrop-blur-xl">
        {content}
      </div>
    </aside>
  );
}
