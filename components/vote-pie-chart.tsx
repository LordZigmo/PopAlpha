"use client";

import { motion } from "framer-motion";

export default function VotePieChart({
  upPct,
  downPct,
  size = 88,
}: {
  upPct: number;
  downPct: number;
  size?: number;
}) {
  const stroke = Math.max(8, Math.round(size * 0.12));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const upLength = (Math.max(0, Math.min(100, upPct)) / 100) * circumference;
  const downLength = circumference - upLength;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.05)"
          strokeWidth={stroke}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#16A34A"
          strokeWidth={stroke}
          strokeLinecap="round"
          initial={false}
          animate={{
            strokeDasharray: `${upLength} ${circumference - upLength}`,
            strokeDashoffset: 0,
          }}
          transition={{ type: "spring", stiffness: 140, damping: 20 }}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#DC2626"
          strokeWidth={stroke}
          strokeLinecap="round"
          initial={false}
          animate={{
            strokeDasharray: `${downLength} ${circumference - downLength}`,
            strokeDashoffset: -upLength,
          }}
          transition={{ type: "spring", stiffness: 140, damping: 20 }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="rounded-full border border-white/[0.05] bg-[#101010] px-3 py-1.5 text-center">
          <p className="text-[15px] font-bold tabular-nums text-white">{upPct.toFixed(0)}%</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Up</p>
        </div>
      </div>
    </div>
  );
}
