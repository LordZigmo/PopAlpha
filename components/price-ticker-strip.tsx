type TickerItem = {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "negative" | "warning";
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

export default function PriceTickerStrip({ items }: PriceTickerStripProps) {
  if (items.length === 0) return null;

  return (
    <div className="ticker-strip flex flex-wrap rounded-2xl border border-[#1E1E1E] bg-[#111111]">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex-1 min-w-[100px] border-l border-[#1E1E1E] px-4 py-3 first:border-l-0"
        >
          <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B]">
            {item.label}
          </p>
          <p className={`mt-1 text-[18px] font-bold tabular-nums tracking-[-0.02em] ${TONE_COLOR[item.tone ?? "neutral"]}`}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}
