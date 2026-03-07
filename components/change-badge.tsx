/**
 * Shared price change badge used in card tiles, search results, and set browser.
 * Works in both server and client components.
 */
export default function ChangeBadge({
  pct,
}: {
  pct: number | null;
  windowLabel?: "24H" | "7D" | null;
}) {
  if (pct == null || pct === 0) return null;
  const up = pct > 0;
  const abs = Math.abs(pct);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return (
    <span
      className="whitespace-nowrap text-[13px] font-semibold tabular-nums"
      style={{ color: up ? "#00DC5A" : "#FF3B30" }}
    >
      {up ? "\u25B2" : "\u25BC"} {up ? "+" : "-"}{formatted}%
    </span>
  );
}
