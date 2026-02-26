export default function RarityRing({ score }: { score: number | null }) {
  const normalized = score === null ? 0 : Math.max(0, Math.min(100, score));
  const circumference = 2 * Math.PI * 42;
  const strokeOffset = circumference * (1 - normalized / 100);

  return (
    <div className="glass density-card rounded-[var(--radius-card)] border-app border p-[var(--space-card)]">
      <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Scarcity Index</p>
      <div className="mt-3 flex items-center gap-4">
        <svg width="110" height="110" viewBox="0 0 110 110" className="shrink-0">
          <circle cx="55" cy="55" r="42" fill="none" stroke="var(--color-border)" strokeWidth="9" />
          <circle
            cx="55"
            cy="55"
            r="42"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
            transform="rotate(-90 55 55)"
            className="ring-meter"
          />
        </svg>
        <div>
          <p className="text-app text-2xl font-semibold tabular-nums">{score === null ? "—" : normalized}</p>
          <p className="text-muted text-xs">0–100 heuristic (lower pop = higher rarity)</p>
        </div>
      </div>
    </div>
  );
}
