import type { ReactNode } from "react";

export default function StatCard({
  label,
  value,
  sublabel,
  highlight,
  tierAccent,
}: {
  label: string;
  value: string;
  sublabel?: ReactNode;
  highlight?: boolean;
  tierAccent?: boolean;
}) {
  return (
    <div
      className={`glass density-card rounded-[var(--radius-card)] border p-[var(--space-card)] ${
        highlight ? "stat-highlight" : "border-app"
      } ${tierAccent ? "tier-label-card" : ""} ${highlight && tierAccent ? "tier-label-premium" : ""}`}
    >
      <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">{label}</p>
      <p className={`mt-2 text-3xl font-semibold tracking-tight sm:text-4xl ${highlight ? "text-positive" : "text-app"}`}>{value}</p>
      {sublabel ? <p className="text-muted mt-1 text-xs">{sublabel}</p> : null}
    </div>
  );
}
