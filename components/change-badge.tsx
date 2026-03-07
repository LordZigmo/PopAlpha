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
  const value = typeof pct === "number" && Number.isFinite(pct) ? pct : 0;
  const up = value > 0;
  const down = value < 0;
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return (
    <span
      className="whitespace-nowrap text-[13px] font-semibold tabular-nums"
      style={{ color: up ? "#00DC5A" : down ? "#FF3B30" : "#9CA3AF" }}
    >
      {up ? "\u25B2" : down ? "\u25BC" : "\u2022"} {up ? "+" : down ? "-" : ""}{formatted}%
    </span>
  );
}
