type TickerItem = {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "negative" | "warning";
  /** Fill the cell background with a muted tone color */
  filled?: boolean;
};

type PriceTickerStripProps = {
  items: TickerItem[];
};

const TONE_COLOR: Record<string, string> = {
  neutral: "text-[#F0F0F0]",
  positive: "text-[#00DC5A]",
  negative: "text-[#FF3B30]",
  warning: "text-amber-200",
};

const FILLED_BG: Record<string, string> = {
  neutral: "bg-[#111111]",
  positive: "bg-[#00DC5A]/[0.08]",
  negative: "bg-[#FF3B30]/[0.08]",
  warning: "bg-amber-400/[0.08]",
};

function gridClass(count: number): string {
  if (count <= 4) return "grid-cols-2";
  return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6";
}

export default function PriceTickerStrip({ items }: PriceTickerStripProps) {
  if (items.length === 0) return null;

  return (
    <div className={`grid gap-px overflow-hidden rounded-2xl border border-[#1E1E1E] bg-[#1E1E1E] ${gridClass(items.length)}`}>
      {items.map((item) => (
        <div
          key={item.label}
          className={`min-w-0 px-3 py-2.5 sm:px-4 sm:py-3 ${item.filled ? FILLED_BG[item.tone ?? "neutral"] : "bg-[#111111]"}`}
        >
          <p className={`truncate text-[11px] font-semibold uppercase tracking-[0.1em] sm:text-[13px] ${item.filled && item.tone && item.tone !== "neutral" ? TONE_COLOR[item.tone] : "text-[#6B6B6B]"}`}>
            {item.label}
          </p>
          <p className={`mt-1 text-[17px] font-bold tabular-nums tracking-[-0.02em] sm:text-[20px] ${TONE_COLOR[item.tone ?? "neutral"]}`}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}
