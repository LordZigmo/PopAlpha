"use client";

import { useEffect, useRef, useState } from "react";

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

function formatVoteCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function TerminalCountdown({ text }: { text: string }) {
  const prevRef = useRef(text);
  const [changedIndices, setChangedIndices] = useState<Set<number>>(new Set());

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = text;
    const changed = new Set<number>();
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== prev[i]) changed.add(i);
    }
    if (changed.size === 0) return;
    setChangedIndices(changed);
    const id = setTimeout(() => setChangedIndices(new Set()), 400);
    return () => clearTimeout(id);
  }, [text]);

  return (
    <p className="mt-4 text-center text-[14px]" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      {text.split("").map((char, i) => (
        <span
          key={i}
          className="inline-block transition-colors duration-300"
          style={{ color: changedIndices.has(i) ? "#F0F0F0" : "#666" }}
        >
          {char}
        </span>
      ))}
      <span className="ml-0.5 inline-block w-[2px] h-[14px] align-middle animate-[terminalBlink_1s_step-end_infinite] bg-[#666]" />
    </p>
  );
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

  function handleVote(vote: "bullish" | "bearish") {
    if (hasVoted) return;
    setUserVote(vote);
    if (vote === "bullish") setBullish((v) => v + 1);
    else setBearish((v) => v + 1);
    // TODO: POST vote to API
  }

  return (
    <div className="mt-6 rounded-2xl border border-[#1E1E1E] bg-[#111111] px-5 py-5">
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

      {/* Split bar */}
      <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-[#1A1A1A]">
        <div
          className="rounded-l-full transition-all duration-500"
          style={{
            width: `${bullishPct}%`,
            backgroundColor: "#377E5C",
            minWidth: total > 0 ? "4px" : undefined,
          }}
        />
        <div
          className="rounded-r-full transition-all duration-500"
          style={{
            width: `${bearishPct}%`,
            backgroundColor: "#7D4549",
            minWidth: total > 0 ? "4px" : undefined,
          }}
        />
      </div>

      {/* Percentages */}
      {total > 0 && (
        <div className="mt-2 flex justify-between">
          <span className="text-[14px] font-semibold tabular-nums" style={{ color: "#6BC99A" }}>
            {bullishPct.toFixed(0)}% Bullish
          </span>
          <span className="text-[14px] font-semibold tabular-nums" style={{ color: "#D4797E" }}>
            {bearishPct.toFixed(0)}% Bearish
          </span>
        </div>
      )}

      {/* Vote buttons */}
      <div className="mt-5 flex gap-3">
        <button
          type="button"
          disabled={hasVoted}
          onClick={() => handleVote("bullish")}
          className={[
            "flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3.5 text-[16px] font-semibold transition-all duration-300",
            hasVoted && userVote === "bullish"
              ? "border-[#377E5C] bg-[#377E5C]/15 text-[#6BC99A]"
              : hasVoted
                ? "border-[#1E1E1E] bg-transparent text-[#333] cursor-default"
                : "border-[#1E1E1E] bg-[#151515] text-[#AAA] hover:border-[#377E5C]/40 hover:text-[#6BC99A]",
          ].join(" ")}
        >
          <span className="text-[16px]" aria-hidden="true">{hasVoted && userVote === "bullish" ? "\u{1F512}" : "\u{1F44D}"}</span>
          Vote Up
        </button>
        <button
          type="button"
          disabled={hasVoted}
          onClick={() => handleVote("bearish")}
          className={[
            "flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3.5 text-[16px] font-semibold transition-all duration-300",
            hasVoted && userVote === "bearish"
              ? "border-[#7D4549] bg-[#7D4549]/15 text-[#D4797E]"
              : hasVoted
                ? "border-[#1E1E1E] bg-transparent text-[#333] cursor-default"
                : "border-[#1E1E1E] bg-[#151515] text-[#AAA] hover:border-[#7D4549]/40 hover:text-[#D4797E]",
          ].join(" ")}
        >
          <span className="text-[16px]" aria-hidden="true">{hasVoted && userVote === "bearish" ? "\u{1F512}" : "\u{1F44E}"}</span>
          Vote Down
        </button>
      </div>

      {/* Countdown */}
      {countdown && <TerminalCountdown text={countdown} />}
    </div>
  );
}
