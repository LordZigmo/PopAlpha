import { useEffect, useState } from "react";

export default function RarityRing({ score, compact = false }: { score: number | null; compact?: boolean }) {
  const normalized = score === null ? 0 : Math.max(0, Math.min(100, score));
  const ringRadius = compact ? 30 : 42;
  const size = compact ? 82 : 110;
  const center = size / 2;
  const circumference = 2 * Math.PI * ringRadius;
  const [displayScore, setDisplayScore] = useState(0);

  useEffect(() => {
    let rafId = 0;
    const start = performance.now();
    const duration = 320;

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      setDisplayScore(Math.round(normalized * progress));
      if (progress < 1) rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [normalized]);

  const strokeOffset = circumference * (1 - displayScore / 100);

  return (
    <div className={`glass density-card rounded-[var(--radius-card)] border-app border p-[var(--space-card)] ${compact ? "ring-compact" : ""}`}>
      <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Scarcity Index</p>
      <div className="mt-3 flex items-center gap-4">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
          <circle cx={center} cy={center} r={ringRadius} fill="none" stroke="var(--color-border)" strokeWidth={compact ? 8 : 9} />
          <circle
            cx={center}
            cy={center}
            r={ringRadius}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={compact ? 8 : 9}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
            transform={`rotate(-90 ${center} ${center})`}
            className="ring-meter"
          />
        </svg>
        <div>
          <p className="text-app text-2xl font-semibold tabular-nums">{score === null ? "—" : displayScore}</p>
          <p className="text-muted text-xs">Relative rarity (0-100)</p>
        </div>
      </div>
    </div>
  );
}
