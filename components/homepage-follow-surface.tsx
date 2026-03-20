"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Bookmark, LineChart, Target } from "lucide-react";

type HomepageFollowSurfaceProps = {
  signedIn: boolean;
};

type SummaryResponse = {
  ok: boolean;
  collectionValue?: number;
  accuracyScore?: number | null;
  setCompletion: {
    setName: string;
    ownedCount: number;
    totalCount: number;
    percent: number;
  } | null;
  watchlist: Array<{
    slug: string;
    name: string;
    setName: string | null;
    imageUrl: string | null;
    currentPrice: number | null;
    isHotMover: boolean;
  }>;
};

const EMPTY_SUMMARY: SummaryResponse = {
  ok: true,
  collectionValue: 0,
  accuracyScore: null,
  setCompletion: null,
  watchlist: [],
};

function formatCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function SummaryStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bookmark;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[1.2rem] border border-white/[0.08] bg-white/[0.03] px-4 py-3">
      <div className="flex items-center gap-2 text-[#90A7C9]">
        <Icon size={15} strokeWidth={2.1} />
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em]">{label}</p>
      </div>
      <p className="mt-3 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function SignedOutSurface() {
  return (
    <section className="rounded-[1.7rem] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(11,16,24,0.92),rgba(7,10,15,0.98))] p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7CB8FF]">Return with context</p>
      <h3 className="mt-3 text-[24px] font-semibold tracking-[-0.03em] text-white">
        Save the signals you want to revisit.
      </h3>
      <p className="mt-3 text-sm leading-7 text-[#9AA5B7]">
        Create a free account to keep a follow list, revisit your strongest names quickly, and pick up the next market change without starting from zero.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link
          href="/sign-up"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-white bg-white px-4 text-sm font-semibold text-[#06080C] transition hover:bg-[#DDE4EF]"
        >
          Create free account
        </Link>
        <Link
          href="/search"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] px-4 text-sm font-semibold text-[#D4DBE6] transition hover:border-white/[0.14] hover:text-white"
        >
          Browse search
        </Link>
      </div>
    </section>
  );
}

export default function HomepageFollowSurface({ signedIn }: HomepageFollowSurfaceProps) {
  const [summary, setSummary] = useState<SummaryResponse>(EMPTY_SUMMARY);
  const [isLoading, setIsLoading] = useState(signedIn);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setSummary(EMPTY_SUMMARY);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    let cancelled = false;

    setIsLoading(true);
    setHasError(false);

    void fetch("/api/holdings/summary", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as SummaryResponse;
        if (!response.ok || !payload.ok) {
          throw new Error("Could not load follow surface.");
        }
        if (!cancelled) {
          setSummary(payload);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasError(true);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  if (!signedIn) {
    return <SignedOutSurface />;
  }

  const hasWatchlist = summary.watchlist.length > 0;
  const focusSet = summary.setCompletion
    ? `${summary.setCompletion.setName} ${summary.setCompletion.percent}% complete`
    : "Build your first focus set";
  const signalRead = summary.accuracyScore != null
    ? `${summary.accuracyScore}% community read`
    : "Vote to build a read score";

  return (
    <section className="rounded-[1.7rem] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(11,16,24,0.92),rgba(7,10,15,0.98))] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7CB8FF]">Your follow list</p>
          <h3 className="mt-3 text-[24px] font-semibold tracking-[-0.03em] text-white">
            Keep the names worth revisiting in one place.
          </h3>
          <p className="mt-3 max-w-xl text-sm leading-7 text-[#9AA5B7]">
            Your saved cards are the fastest way back into the market. Check the names you already care about, then let the movers board tell you when leadership shifts.
          </p>
        </div>
        <Link
          href="/portfolio"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white bg-white px-4 text-sm font-semibold text-[#06080C] transition hover:bg-[#DDE4EF]"
        >
          Open portfolio
          <ArrowRight size={15} strokeWidth={2.2} />
        </Link>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <SummaryStat icon={Bookmark} label="Saved focus" value={hasWatchlist ? `${summary.watchlist.length} names active` : "No saved cards yet"} />
        <SummaryStat icon={LineChart} label="Portfolio value" value={formatCurrency(summary.collectionValue)} />
        <SummaryStat icon={Target} label="Market read" value={signalRead} />
      </div>

      <div className="mt-5 rounded-[1.4rem] border border-white/[0.08] bg-white/[0.03] px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#71819B]">Focus set</p>
        <p className="mt-2 text-sm font-semibold text-white">{focusSet}</p>
        {summary.setCompletion ? (
          <p className="mt-1 text-[13px] text-[#7F8A9B]">
            {summary.setCompletion.ownedCount} of {summary.setCompletion.totalCount} tracked cards logged so far.
          </p>
        ) : (
          <p className="mt-1 text-[13px] text-[#7F8A9B]">Add a card to your portfolio to start building a reusable signal loop.</p>
        )}
      </div>

      <div className="mt-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-white">Saved signals</p>
          <Link href="/search" className="text-[13px] font-semibold text-[#9CC8FF] transition hover:text-white">
            Add another card
          </Link>
        </div>

        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-24 rounded-[1.2rem] border border-white/[0.06] bg-white/[0.03]" />
            ))}
          </div>
        ) : hasError ? (
          <div className="rounded-[1.2rem] border border-dashed border-white/[0.08] bg-white/[0.02] px-4 py-5 text-sm text-[#8A95A7]">
            We could not load your saved cards right now. Your portfolio is still available when you want to drill in directly.
          </div>
        ) : hasWatchlist ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {summary.watchlist.slice(0, 4).map((item) => (
              <Link
                key={item.slug}
                href={`/c/${encodeURIComponent(item.slug)}`}
                className="flex items-center gap-3 rounded-[1.2rem] border border-white/[0.06] bg-[#0B1017] px-4 py-3 transition hover:border-white/[0.12]"
              >
                <div className="h-16 w-12 shrink-0 overflow-hidden rounded-[0.9rem] border border-white/[0.08] bg-white/[0.03]">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt={item.name} className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-white">{item.name}</p>
                    {item.isHotMover ? <span className="h-2 w-2 shrink-0 rounded-full bg-[#63D471] shadow-[0_0_10px_rgba(99,212,113,0.9)]" /> : null}
                  </div>
                  <p className="mt-1 truncate text-[13px] text-[#7F8A9B]">{item.setName ?? "Unknown set"}</p>
                  <p className="mt-2 text-[13px] font-semibold text-[#E5ECF6]">{formatCurrency(item.currentPrice)}</p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="rounded-[1.2rem] border border-dashed border-white/[0.08] bg-white/[0.02] px-4 py-5">
            <p className="text-sm font-semibold text-white">No saved signals yet</p>
            <p className="mt-2 text-sm leading-6 text-[#8A95A7]">
              Add your first card to the portfolio to build a shortlist you can return to whenever the market board starts moving.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
