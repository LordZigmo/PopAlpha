function pct(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export default function PopulationBar({ higherShare, topTierShare }: { higherShare: number | null; topTierShare: number | null }) {
  const higher = higherShare ?? 0;
  const atGradeOrLower = topTierShare ?? 0;

  return (
    <div className="glass density-card rounded-[var(--radius-card)] border-app border p-[var(--space-card)]">
      <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Population Split</p>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full border-app border bg-surface">
        <div style={{ width: `${higher * 100}%`, background: "var(--color-negative)" }} />
        <div style={{ width: `${atGradeOrLower * 100}%`, background: "var(--color-positive)" }} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <p className="text-muted">Higher grades: <span className="text-negative tabular-nums">{pct(higherShare)}</span></p>
        <p className="text-muted">At grade/lower: <span className="text-positive tabular-nums">{pct(topTierShare)}</span></p>
      </div>
    </div>
  );
}
