"use client";

import { useEffect, useRef, useState } from "react";

type SignalGaugeProps = {
  label: string;
  score: number | null;
  displayLabel?: string;
};

function arcColor(score: number): string {
  if (score < 33) return "#FF3B30";
  if (score < 67) return "#FFD60A";
  return "#00DC5A";
}

const ARC_RADIUS = 46;
const ARC_CIRCUMFERENCE = Math.PI * ARC_RADIUS; // half-circle

export default function SignalGauge({ label, score, displayLabel }: SignalGaugeProps) {
  const [animatedOffset, setAnimatedOffset] = useState(ARC_CIRCUMFERENCE);
  const [displayNumber, setDisplayNumber] = useState(0);
  const arcRafRef = useRef(0);
  const numRafRef = useRef(0);

  const safeScore = score !== null && Number.isFinite(score) ? Math.max(0, Math.min(score, 100)) : null;
  const targetOffset = safeScore !== null ? ARC_CIRCUMFERENCE * (1 - safeScore / 100) : ARC_CIRCUMFERENCE;
  const color = safeScore !== null ? arcColor(safeScore) : "#333";

  // Arc animation
  useEffect(() => {
    if (safeScore === null) {
      setAnimatedOffset(ARC_CIRCUMFERENCE);
      return;
    }

    const start = performance.now();
    const from = ARC_CIRCUMFERENCE;
    const to = targetOffset;
    const duration = 600;

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      setAnimatedOffset(from + (to - from) * ease);
      if (t < 1) {
        arcRafRef.current = requestAnimationFrame(tick);
      }
    };

    arcRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (arcRafRef.current) cancelAnimationFrame(arcRafRef.current);
    };
  }, [safeScore, targetOffset]);

  // Number count-up animation
  useEffect(() => {
    if (safeScore === null) {
      setDisplayNumber(0);
      return;
    }

    const start = performance.now();
    const duration = 600;
    const target = safeScore;

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      setDisplayNumber(Math.round(ease * target));
      if (t < 1) {
        numRafRef.current = requestAnimationFrame(tick);
      }
    };

    numRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (numRafRef.current) cancelAnimationFrame(numRafRef.current);
    };
  }, [safeScore]);

  return (
    <div className="gauge-card flex flex-col items-center rounded-2xl border border-white/[0.06] bg-[#111111] px-2 py-3 sm:px-3 sm:py-4">
      <svg viewBox="0 0 120 72" className="w-full max-w-[120px]" aria-label={`${label}: ${safeScore !== null ? safeScore : "N/A"}`}>
        {/* Background arc */}
        <path
          d="M 14 66 A 46 46 0 0 1 106 66"
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="8"
          strokeLinecap="round"
        />
        {/* Foreground arc */}
        <path
          d="M 14 66 A 46 46 0 0 1 106 66"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          className="gauge-arc"
          strokeDasharray={ARC_CIRCUMFERENCE}
          strokeDashoffset={animatedOffset}
        />
        {/* Score text — animated count-up */}
        <text
          x="60"
          y="56"
          textAnchor="middle"
          className="fill-[#F0F0F0]"
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: "24px", fontWeight: 700 }}
        >
          {safeScore !== null ? displayNumber : "--"}
        </text>
      </svg>
      <p className="mt-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B] sm:text-[14px]">
        {label}
      </p>
      {displayLabel && (
        <p className="mt-0.5 text-[13px] font-semibold sm:text-[15px]" style={{ color }}>
          {displayLabel}
        </p>
      )}
    </div>
  );
}
