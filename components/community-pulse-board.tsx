"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import type { CommunityPulseCard, CommunityVoteSide } from "@/lib/data/community-pulse";
import VotePieChart from "@/components/vote-pie-chart";

type CommunityPulseBoardProps = {
  cards: CommunityPulseCard[];
  votesRemaining: number;
  weeklyLimit: number;
  weekEndsAt: number;
  signedIn: boolean;
};

type VoteResponse = {
  ok: boolean;
  vote?: CommunityVoteSide;
  bullishVotes?: number;
  bearishVotes?: number;
  votesRemaining?: number;
  error?: string;
};

type FollowedVoteEvent = {
  canonicalSlug: string;
  vote: CommunityVoteSide;
  createdAt: string;
  cardName: string | null;
  setName: string | null;
};

type CommunityPulseStatusResponse = {
  ok: boolean;
  votesRemaining?: number;
  followedVotes?: FollowedVoteEvent[];
};

function formatCountdown(weekEndsAt: number): string {
  const diff = Math.max(0, weekEndsAt - Date.now());
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  return `${days}d ${String(hours).padStart(2, "0")}h left`;
}

function formatChange(pct: number | null): string {
  if (pct == null || pct === 0) return "Flat";
  const abs = Math.abs(pct);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${pct > 0 ? "+" : "-"}${formatted}%`;
}

function FollowSignal({
  followedUpCount,
  followedDownCount,
}: {
  followedUpCount: number;
  followedDownCount: number;
}) {
  if (followedUpCount === 0 && followedDownCount === 0) return null;

  let label = "";
  let color = "#A3A3A3";
  if (followedUpCount > 0 && followedDownCount > 0) {
    label = `${followedUpCount + followedDownCount} people you follow are split`;
    color = "#D4D4D8";
  } else if (followedUpCount > 0) {
    label = `${followedUpCount} ${followedUpCount === 1 ? "person" : "people"} you follow voted up`;
    color = "#8DF0B4";
  } else {
    label = `${followedDownCount} ${followedDownCount === 1 ? "person" : "people"} you follow voted down`;
    color = "#F5A1A7";
  }

  return (
    <p className="mt-3 text-[13px] font-medium leading-5" style={{ color }}>
      {label}
    </p>
  );
}

export default function CommunityPulseBoard({
  cards: initialCards,
  votesRemaining: initialVotesRemaining,
  weeklyLimit,
  weekEndsAt,
  signedIn,
}: CommunityPulseBoardProps) {
  const router = useRouter();
  const [cards, setCards] = useState(initialCards);
  const [votesRemaining, setVotesRemaining] = useState(initialVotesRemaining);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [celebratingSlug, setCelebratingSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followedVotes, setFollowedVotes] = useState<FollowedVoteEvent[]>([]);

  const countdown = useMemo(() => formatCountdown(weekEndsAt), [weekEndsAt]);

  useEffect(() => {
    if (!signedIn) {
      setFollowedVotes([]);
      return;
    }

    let cancelled = false;

    void fetch("/api/community-pulse", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as CommunityPulseStatusResponse;
        if (!response.ok || !payload.ok) {
          throw new Error("Could not load community pulse status.");
        }
        if (!cancelled) {
          if (typeof payload.votesRemaining === "number") {
            setVotesRemaining(payload.votesRemaining);
          }
          setFollowedVotes(payload.followedVotes ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setFollowedVotes([]);
      });

    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  async function castVote(cardSlug: string, direction: CommunityVoteSide) {
    if (!signedIn) {
      router.push("/sign-up");
      return;
    }
    if (activeSlug || votesRemaining <= 0) return;

    const current = cards.find((card) => card.slug === cardSlug);
    if (!current || current.userVote) return;

    setError(null);
    setActiveSlug(cardSlug);
    setCelebratingSlug(cardSlug);

    setCards((previous) =>
      previous.map((card) =>
        card.slug === cardSlug
          ? {
              ...card,
              userVote: direction,
              bullishVotes: direction === "up" ? card.bullishVotes + 1 : card.bullishVotes,
              bearishVotes: direction === "down" ? card.bearishVotes + 1 : card.bearishVotes,
            }
          : card,
      ),
    );
    setVotesRemaining((value) => Math.max(0, value - 1));

    try {
      const response = await fetch("/api/community-pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalSlug: cardSlug, direction }),
      });
      const payload = (await response.json()) as VoteResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Could not record vote.");
      }

      setCards((previous) =>
        previous.map((card) =>
          card.slug === cardSlug
            ? {
                ...card,
                userVote: payload.vote ?? card.userVote,
                bullishVotes: payload.bullishVotes ?? card.bullishVotes,
                bearishVotes: payload.bearishVotes ?? card.bearishVotes,
              }
            : card,
        ),
      );
      if (typeof payload.votesRemaining === "number") {
        setVotesRemaining(payload.votesRemaining);
      }
      if (signedIn) {
        const statusResponse = await fetch("/api/community-pulse", { cache: "no-store" });
        const statusPayload = (await statusResponse.json()) as CommunityPulseStatusResponse;
        if (statusResponse.ok && statusPayload.ok) {
          if (typeof statusPayload.votesRemaining === "number") {
            setVotesRemaining(statusPayload.votesRemaining);
          }
          setFollowedVotes(statusPayload.followedVotes ?? []);
        }
      }
    } catch (voteError) {
      setCards(initialCards);
      setVotesRemaining(initialVotesRemaining);
      setError(voteError instanceof Error ? voteError.message : "Could not record vote.");
    } finally {
      setActiveSlug(null);
      setTimeout(() => setCelebratingSlug((current) => (current === cardSlug ? null : current)), 900);
    }
  }

  if (cards.length === 0) {
    return (
      <div className="rounded-[1.75rem] border border-dashed border-white/[0.08] bg-[#111]/50 px-6 py-7">
        <p className="text-[15px] leading-6 text-[#666]">We need a few more cards before voting opens.</p>
      </div>
    );
  }

  return (
    <div className="px-1 py-2 sm:px-0 sm:py-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-3 w-3 rounded-full bg-[#63D471] shadow-[0_0_12px_rgba(99,212,113,0.9)]" />
            <h3 className="text-[22px] font-semibold tracking-[-0.02em] text-white sm:text-[24px]">Community Pulse</h3>
          </div>
          <p className="mt-2 text-[15px] leading-6 text-[#9A9A9A]">Use your weekly votes on the cards you think move next.</p>
        </div>
        <div className="flex items-center gap-2.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-[14px]">
          <span className="font-bold text-white">{votesRemaining}</span>
          <span className="text-[#A3A3A3]">of {weeklyLimit} left</span>
          <span className="text-[#5E6B85]">•</span>
          <span className="text-[#A3A3A3]">{countdown}</span>
        </div>
      </div>

      {!signedIn ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#1E1E1E] bg-white/[0.03] px-5 py-4">
          <p className="text-[15px] leading-6 text-[#A3A3A3]">Sign up to vote on where these cards go next.</p>
          <Link
            href="/sign-up"
            className="rounded-2xl border px-3.5 py-2 text-[12px] font-bold tracking-[0.08em] transition hover:opacity-90"
            style={{ backgroundColor: "#FFFFFF", color: "#0A0A0A", borderColor: "#FFFFFF" }}
          >
            Sign up
          </Link>
        </div>
      ) : null}

      {signedIn && followedVotes.length > 0 ? (
        <div className="mt-5 rounded-[1.5rem] border border-white/[0.06] bg-white/[0.03] px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[#60A5FA] shadow-[0_0_10px_rgba(96,165,250,0.8)]" />
            <p className="text-[15px] font-semibold text-white">People You Follow</p>
          </div>
          <div className="mt-3 space-y-2.5">
            {followedVotes.slice(0, 4).map((event) => (
              <Link
                key={`${event.canonicalSlug}:${event.createdAt}:${event.vote}`}
                href={`/c/${encodeURIComponent(event.canonicalSlug)}`}
                className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.04] bg-black/[0.16] px-4 py-3 transition hover:border-white/[0.08]"
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-white">
                    Someone you follow voted {event.vote === "up" ? "up" : "down"}
                  </p>
                  <p className="mt-1 truncate text-[13px] text-[#8A8A8A]">
                    {event.cardName ?? event.canonicalSlug}
                    {event.setName ? ` • ${event.setName}` : ""}
                  </p>
                </div>
                <span
                  className="shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-bold uppercase tracking-[0.14em]"
                  style={{
                    color: event.vote === "up" ? "#93C5FD" : "#FDA4AF",
                    borderColor: event.vote === "up" ? "rgba(147,197,253,0.24)" : "rgba(253,164,175,0.24)",
                    backgroundColor: event.vote === "up" ? "rgba(147,197,253,0.08)" : "rgba(253,164,175,0.08)",
                  }}
                >
                  {event.vote === "up" ? "Up" : "Down"}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {cards.map((card) => {
          const totalVotes = card.bullishVotes + card.bearishVotes;
          const upPct = totalVotes > 0 ? (card.bullishVotes / totalVotes) * 100 : 50;
          const downPct = totalVotes > 0 ? (card.bearishVotes / totalVotes) * 100 : 50;
          const isVoting = activeSlug === card.slug;
          const voteLocked = !signedIn || !!card.userVote || (votesRemaining <= 0 && !card.userVote) || isVoting;

          return (
            <div
              key={card.slug}
              className="rounded-[1.75rem] border border-white/[0.06] bg-[radial-gradient(circle_at_top_right,rgba(71,85,105,0.18),transparent_30%),rgba(255,255,255,0.02)] p-4 sm:p-5"
            >
              <div className="flex gap-5 sm:gap-6">
                <Link
                  href={`/c/${encodeURIComponent(card.slug)}`}
                  className="relative block aspect-[63/88] w-[124px] shrink-0 overflow-hidden rounded-[1.15rem] border border-white/[0.06] bg-[#0B0B0B] sm:w-[136px]"
                >
                  {card.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.imageUrl} alt={card.name} className="h-full w-full object-cover" />
                  ) : null}
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/c/${encodeURIComponent(card.slug)}`} className="line-clamp-2 text-[17px] font-semibold leading-6 text-white hover:text-[#DDE8FF] sm:text-[18px]">
                        {card.name}
                      </Link>
                      <p className="mt-1.5 truncate text-[14px] text-[#6B7280]">{card.setName ?? "Unknown set"}</p>
                    </div>
                    <span
                      className="rounded-full border px-3 py-1.5 text-[13px] font-bold tabular-nums"
                      style={{
                        color: (card.changePct ?? 0) >= 0 ? "#8DF0B4" : "#F5A1A7",
                        borderColor: (card.changePct ?? 0) >= 0 ? "rgba(99,212,113,0.22)" : "rgba(245,161,167,0.22)",
                        backgroundColor: (card.changePct ?? 0) >= 0 ? "rgba(99,212,113,0.08)" : "rgba(245,161,167,0.08)",
                      }}
                    >
                      {formatChange(card.changePct)}
                    </span>
                  </div>

                  <div className="mt-4 flex items-center gap-4">
                    <div
                      className={[
                        "relative rounded-full",
                        celebratingSlug === card.slug ? "shadow-[0_0_24px_rgba(34,197,94,0.18)]" : "",
                      ].join(" ")}
                    >
                      <VotePieChart upPct={upPct} downPct={downPct} />
                      {celebratingSlug === card.slug ? (
                        <>
                          {[
                            { left: "14%", color: "#22C55E", delay: 0 },
                            { left: "50%", color: "#FACC15", delay: 0.05 },
                            { left: "78%", color: "#38BDF8", delay: 0.1 },
                          ].map((spark) => (
                            <motion.span
                              key={`${card.slug}-${spark.left}-${spark.color}`}
                              className="absolute top-1/2 h-1.5 w-1.5 rounded-full"
                              style={{ left: spark.left, backgroundColor: spark.color }}
                              initial={{ opacity: 0.9, y: -4, scale: 0.8 }}
                              animate={{ opacity: 0, y: -22, scale: 1.35 }}
                              transition={{ duration: 0.55, delay: spark.delay, ease: "easeOut" }}
                            />
                          ))}
                        </>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between text-[14px] font-semibold">
                        <span className="text-[#16A34A]">{upPct.toFixed(0)}% think up</span>
                        <span className="text-[#DC2626]">{downPct.toFixed(0)}% think down</span>
                      </div>

                      <FollowSignal
                        followedUpCount={card.followedUpCount}
                        followedDownCount={card.followedDownCount}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => castVote(card.slug, "up")}
                  disabled={signedIn ? voteLocked : false}
                  className={[
                    "group rounded-2xl border px-4 py-4 text-left transition",
                    card.userVote === "up"
                      ? "border-[#38BDF8]/50 bg-[linear-gradient(135deg,rgba(29,78,216,0.24),rgba(56,189,248,0.08))]"
                      : "border-white/[0.06] bg-white/[0.03] hover:border-[#38BDF8]/35 hover:bg-[linear-gradient(135deg,rgba(29,78,216,0.16),rgba(255,255,255,0.03))]",
                    voteLocked && !card.userVote ? "opacity-60" : "",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-semibold uppercase tracking-[0.14em] text-[#93C5FD]">Vote Up</span>
                    <span className="text-[18px]">↗</span>
                  </div>
                  <p className="mt-2 text-[15px] font-semibold leading-6 text-white">
                    {card.userVote === "up" ? "You backed it" : "Buyers stay in control"}
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => castVote(card.slug, "down")}
                  disabled={signedIn ? voteLocked : false}
                  className={[
                    "group rounded-2xl border px-4 py-4 text-left transition",
                    card.userVote === "down"
                      ? "border-[#FB7185]/50 bg-[linear-gradient(135deg,rgba(249,115,22,0.18),rgba(251,113,133,0.08))]"
                      : "border-white/[0.06] bg-white/[0.03] hover:border-[#FB7185]/35 hover:bg-[linear-gradient(135deg,rgba(249,115,22,0.14),rgba(255,255,255,0.03))]",
                    voteLocked && !card.userVote ? "opacity-60" : "",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-semibold uppercase tracking-[0.14em] text-[#FDA4AF]">Vote Down</span>
                    <span className="text-[18px]">↘</span>
                  </div>
                  <p className="mt-2 text-[15px] font-semibold leading-6 text-white">
                    {card.userVote === "down" ? "You faded it" : "This move loses steam"}
                  </p>
                </button>
              </div>

              <p className="mt-4 text-[14px] leading-6 text-[#777]">
                {totalVotes > 0 ? `${totalVotes} vote${totalVotes === 1 ? "" : "s"} on this contract this week.` : "No one has priced this one in yet."}
              </p>
            </div>
          );
        })}
      </div>

      <AnimatePresence>
        {error ? (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="mt-4 text-[14px] text-[#FF9A9A]"
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
