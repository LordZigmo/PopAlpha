"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import VotePieChart from "@/components/vote-pie-chart";

type MarketPulseProps = {
  canonicalSlug: string;
  cardName: string;
  setName: string | null;
  imageUrl: string | null;
  changePct: number | null;
  bullishVotes: number;
  bearishVotes: number;
  userVote: "up" | "down" | null;
  resolvesAt: number | null;
};

function formatCountdown(resolvesAt: number | null, now: number): string | null {
  if (resolvesAt === null) return null;
  const diff = resolvesAt - now;
  if (diff <= 0) return "Resolved";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `Resolves in ${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (hours > 0) return `Resolves in ${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `Resolves in ${minutes}m ${pad(seconds)}s`;
}

type VoteResponse = {
  ok: boolean;
  vote?: "up" | "down";
  bullishVotes?: number;
  bearishVotes?: number;
  error?: string;
};

function formatVoteCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function formatChange(pct: number | null): string {
  if (pct == null || pct === 0) return "Flat";
  const abs = Math.abs(pct);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${pct > 0 ? "+" : "-"}${formatted}%`;
}

export default function MarketPulse({
  canonicalSlug,
  cardName,
  setName,
  imageUrl,
  changePct,
  bullishVotes: initialBullish,
  bearishVotes: initialBearish,
  userVote: initialUserVote,
  resolvesAt,
}: MarketPulseProps) {
  const [bullish, setBullish] = useState(initialBullish);
  const [bearish, setBearish] = useState(initialBearish);
  const [userVote, setUserVote] = useState(initialUserVote);

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const total = bullish + bearish;
  const bullishPct = total > 0 ? (bullish / total) * 100 : 50;
  const bearishPct = total > 0 ? (bearish / total) * 100 : 50;
  const hasVoted = userVote !== null;
  const countdown = formatCountdown(resolvesAt, now);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVote(vote: "up" | "down") {
    if (hasVoted || pending) return;
    setPending(true);
    setError(null);

    if (vote === "up") setBullish((v) => v + 1);
    else setBearish((v) => v + 1);
    setUserVote(vote);

    try {
      const response = await fetch("/api/community-pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalSlug, direction: vote }),
      });
      const payload = (await response.json()) as VoteResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Could not record vote.");
      }
      if (typeof payload.bullishVotes === "number") setBullish(payload.bullishVotes);
      if (typeof payload.bearishVotes === "number") setBearish(payload.bearishVotes);
      if (payload.vote) setUserVote(payload.vote);
    } catch (voteError) {
      setUserVote(initialUserVote);
      setBullish(initialBullish);
      setBearish(initialBearish);
      setError(voteError instanceof Error ? voteError.message : "Could not record vote.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="glass-target mt-6 rounded-2xl border border-[#1E1E1E] bg-[#111111] px-5 py-5">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="pulse-live-dot relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-[livePing_2.4s_ease-in-out_infinite] rounded-full bg-[#3A9A5B] opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#3A9A5B]" />
          </span>
          <p className="text-[22px] font-semibold text-[#F0F0F0]">
            Market Pulse
          </p>
        </div>
        {total > 0 && (
          <p className="text-[13px] tabular-nums text-[#555]">
            {formatVoteCount(total)} vote{total !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      <div className="rounded-[1.5rem] border border-white/[0.06] bg-[radial-gradient(circle_at_top_right,rgba(71,85,105,0.18),transparent_30%),rgba(255,255,255,0.02)] p-4 sm:p-5">
        <div className="flex gap-5 sm:gap-6">
          <Link
            href={`/c/${encodeURIComponent(canonicalSlug)}`}
            className="relative block aspect-[63/88] w-[112px] shrink-0 overflow-hidden rounded-[1.15rem] border border-white/[0.06] bg-[#0B0B0B]"
          >
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt={cardName} className="h-full w-full object-cover" />
            ) : null}
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link
                  href={`/c/${encodeURIComponent(canonicalSlug)}`}
                  className="line-clamp-2 text-[17px] font-semibold leading-6 text-white hover:text-[#DDE8FF] sm:text-[18px]"
                >
                  {cardName}
                </Link>
                <p className="mt-1.5 truncate text-[14px] text-[#6B7280]">{setName ?? "Unknown set"}</p>
              </div>
              <span
                className="rounded-full border px-3 py-1.5 text-[13px] font-bold tabular-nums"
                style={{
                  color: (changePct ?? 0) >= 0 ? "#8DF0B4" : "#F5A1A7",
                  borderColor: (changePct ?? 0) >= 0 ? "rgba(99,212,113,0.22)" : "rgba(245,161,167,0.22)",
                  backgroundColor: (changePct ?? 0) >= 0 ? "rgba(99,212,113,0.08)" : "rgba(245,161,167,0.08)",
                }}
              >
                {formatChange(changePct)}
              </span>
            </div>

            <div className="mt-4 flex items-center gap-4">
              <VotePieChart upPct={bullishPct} downPct={bearishPct} size={96} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between text-[14px] font-semibold">
                  <span className="text-[#16A34A]">{bullishPct.toFixed(0)}% Up</span>
                  <span className="text-[#DC2626]">{bearishPct.toFixed(0)}% Down</span>
                </div>
                <p className="mt-2 text-[14px] leading-6 text-[#777]">
                  {total > 0 ? `${total} vote${total === 1 ? "" : "s"} on this contract this week.` : "No one has priced this one in yet."}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Vote buttons */}
      <div className="mt-5 flex gap-3">
        <button
          type="button"
          disabled={hasVoted || pending}
          onClick={() => handleVote("up")}
          className={[
            "flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3.5 text-[16px] font-semibold transition-all duration-300",
            hasVoted && userVote === "up"
              ? "border-[#377E5C] bg-[#377E5C]/15 text-[#6BC99A]"
              : hasVoted
                ? "border-[#1E1E1E] bg-transparent text-[#333] cursor-default"
                : "border-[#1E1E1E] bg-[#151515] text-[#AAA] hover:border-[#377E5C]/40 hover:text-[#6BC99A]",
          ].join(" ")}
        >
          <span className="text-[16px]" aria-hidden="true">{hasVoted && userVote === "up" ? "\u{1F512}" : "\u{1F44D}"}</span>
          Vote Up
        </button>
        <button
          type="button"
          disabled={hasVoted || pending}
          onClick={() => handleVote("down")}
          className={[
            "flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3.5 text-[16px] font-semibold transition-all duration-300",
            hasVoted && userVote === "down"
              ? "border-[#7D4549] bg-[#7D4549]/15 text-[#D4797E]"
              : hasVoted
                ? "border-[#1E1E1E] bg-transparent text-[#333] cursor-default"
                : "border-[#1E1E1E] bg-[#151515] text-[#AAA] hover:border-[#7D4549]/40 hover:text-[#D4797E]",
          ].join(" ")}
        >
          <span className="text-[16px]" aria-hidden="true">{hasVoted && userVote === "down" ? "\u{1F512}" : "\u{1F44E}"}</span>
          Vote Down
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-center text-[13px] text-[#FF9A9A]">{error}</p>
      ) : null}
      {countdown && (
        <p className="mt-4 text-center text-[14px] tabular-nums text-[#666]">
          {countdown}
        </p>
      )}
    </div>
  );
}
