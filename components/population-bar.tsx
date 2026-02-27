function pct(value: number | null): string {
  if (value === null) return "—";
  const n = value * 100;
  const formatted = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  return `${formatted}%`;
}

function count(value: number | null): string {
  if (value === null) return "—";
  return String(value);
}

export default function PopulationBar({
  higherShare,
  topTierShare,
  higherCount,
  atGradeOrLowerCount,
}: {
  higherShare: number | null;
  topTierShare: number | null;
  higherCount: number | null;
  atGradeOrLowerCount: number | null;
}) {
  const higher = higherShare ?? 0;
  const atGradeOrLower = topTierShare ?? 0;
  const hasHigher = (higherCount ?? 0) > 0;

  return (
    <div className="glass density-card rounded-[var(--radius-card)] border-app border p-[var(--space-card)]">
      <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Population Split</p>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full border-app border bg-surface">
        {hasHigher ? <div style={{ width: `${higher * 100}%`, background: "var(--color-negative)" }} /> : null}
        <div style={{ width: `${hasHigher ? atGradeOrLower * 100 : 100}%`, background: "var(--color-positive)" }} />
      </div>
      <div className="mt-2 space-y-1 text-xs">
        {hasHigher ? (
          <p className="text-muted">
            Higher: <span className="text-negative tabular-nums">{count(higherCount)}</span>{" "}
            <span className="tabular-nums">({pct(higherShare)})</span>
          </p>
        ) : null}
        <p className="text-muted">
          At grade/lower: <span className="text-positive tabular-nums">{count(atGradeOrLowerCount)}</span>{" "}
          <span className="tabular-nums">({pct(topTierShare)})</span>
        </p>
      </div>
    </div>
  );
}
