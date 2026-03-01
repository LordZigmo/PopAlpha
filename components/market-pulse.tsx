"use client";

import { useState } from "react";

type MarketPulseProps = {
  /** Total bullish votes — wire to DB later */
  bullishVotes: number;
  /** Total bearish votes — wire to DB later */
  bearishVotes: number;
  /** Whether the current user has already voted — wire to auth/DB later */
  userVote: "bullish" | "bearish" | null;
  /** Epoch ms when the current voting window closes — wire to DB later */
  resolvesAt: number | null;
};

function formatCountdown(resolvesAt: number | null): string | null {
  if (resolvesAt === null) return null;
  const diff = resolvesAt - Date.now();
  if (diff <= 0) return "Resolved";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `Resolves in ${days}d ${hours}h`;
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `Resolves in ${hours}h ${minutes}m`;
}

function formatVoteCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

export default function MarketPulse({
  bullishVotes: initialBullish,
  bearishVotes: initialBearish,
  userVote: initialUserVote,
  resolvesAt,
}: MarketPulseProps) {
  const [bullish, setBullish] = useState(initialBullish);
  const [bearish, setBearish] = useState(initialBearish);
  const [userVote, setUserVote] = useState(initialUserVote);

  const total = bullish + bearish;
  const bullishPct = total > 0 ? (bullish / total) * 100 : 50;
  const bearishPct = total > 0 ? (bearish / total) * 100 : 50;
  const hasVoted = userVote !== null;
  const countdown = formatCountdown(resolvesAt);

  function handleVote(vote: "bullish" | "bearish") {
    if (hasVoted) return;
    setUserVote(vote);
    if (vote === "bullish") setBullish((v) => v + 1);
    else setBearish((v) => v + 1);
    // TODO: POST vote to API
  }

  return (
    <div className="mt-6">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">
          Market Pulse
        </p>
        {total > 0 && (
          <p className="text-[11px] tabular-nums text-[#555]">
            {formatVoteCount(total)} vote{total !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {/* Split bar */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[#1A1A1A]">
        <div
          className="rounded-l-full transition-all duration-500"
          style={{
            width: `${bullishPct}%`,
            backgroundColor: "#2D6A4F",
            minWidth: total > 0 ? "4px" : undefined,
          }}
        />
        <div
          className="rounded-r-full transition-all duration-500"
          style={{
            width: `${bearishPct}%`,
            backgroundColor: "#6B3A3A",
            minWidth: total > 0 ? "4px" : undefined,
          }}
        />
      </div>

      {/* Percentages */}
      {total > 0 && (
        <div className="mt-1.5 flex justify-between">
          <span className="text-[11px] font-semibold tabular-nums" style={{ color: "#52B788" }}>
            {bullishPct.toFixed(0)}% Bullish
          </span>
          <span className="text-[11px] font-semibold tabular-nums" style={{ color: "#C1666B" }}>
            {bearishPct.toFixed(0)}% Bearish
          </span>
        </div>
      )}

      {/* Vote buttons */}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          disabled={hasVoted}
          onClick={() => handleVote("bullish")}
          className={[
            "flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-[13px] font-semibold transition-all duration-300",
            hasVoted && userVote === "bullish"
              ? "border-[#2D6A4F] bg-[#2D6A4F]/15 text-[#52B788]"
              : hasVoted
                ? "border-[#1E1E1E] bg-transparent text-[#333] cursor-default"
                : "border-[#1E1E1E] bg-[#111111] text-[#999] hover:border-[#2D6A4F]/40 hover:text-[#52B788]",
          ].join(" ")}
        >
          <span className="text-[15px]" aria-hidden="true">{hasVoted && userVote === "bullish" ? "\u{1F512}" : "\u{1F44D}"}</span>
          Vote Up
        </button>
        <button
          type="button"
          disabled={hasVoted}
          onClick={() => handleVote("bearish")}
          className={[
            "flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-[13px] font-semibold transition-all duration-300",
            hasVoted && userVote === "bearish"
              ? "border-[#6B3A3A] bg-[#6B3A3A]/15 text-[#C1666B]"
              : hasVoted
                ? "border-[#1E1E1E] bg-transparent text-[#333] cursor-default"
                : "border-[#1E1E1E] bg-[#111111] text-[#999] hover:border-[#6B3A3A]/40 hover:text-[#C1666B]",
          ].join(" ")}
        >
          <span className="text-[15px]" aria-hidden="true">{hasVoted && userVote === "bearish" ? "\u{1F512}" : "\u{1F44E}"}</span>
          Vote Down
        </button>
      </div>

      {/* Countdown */}
      {hasVoted && countdown && (
        <p className="mt-3 text-center text-[12px] text-[#555]">
          {countdown}
        </p>
      )}
    </div>
  );
}
