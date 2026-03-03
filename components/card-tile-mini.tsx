import Link from "next/link";
import type { HomepageCard } from "@/lib/data/homepage";

const TIER_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  hot:     { label: "Hot",     color: "#00DC5A", bg: "rgba(0,220,90,0.08)" },
  warming: { label: "Warming", color: "#FFD60A", bg: "rgba(255,214,10,0.08)" },
  cooling: { label: "Cooling", color: "#64D2FF", bg: "rgba(100,210,255,0.08)" },
  cold:    { label: "Cold",    color: "#FF3B30", bg: "rgba(255,59,48,0.08)" },
};

function formatPrice(n: number | null): string {
  if (n == null || n <= 0) return "--";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function TrendArrow({ slope }: { slope: number | null }) {
  if (slope == null || slope === 0) return null;
  const up = slope > 0;
  return (
    <span
      className="text-[13px] font-semibold"
      style={{ color: up ? "#00DC5A" : "#FF3B30" }}
    >
      {up ? "\u25B2" : "\u25BC"}
    </span>
  );
}

/**
 * Card tile with image for homepage carousels.
 * Server component — no "use client".
 */
export default function CardTileMini({
  card,
  showTier = false,
}: {
  card: HomepageCard;
  showTier?: boolean;
}) {
  const tier = card.mover_tier ? TIER_STYLES[card.mover_tier] : null;

  return (
    <Link
      href={`/c/${encodeURIComponent(card.slug)}`}
      className="group flex w-[160px] shrink-0 flex-col rounded-2xl border border-white/[0.06] bg-[#111] transition hover:border-white/[0.12] hover:bg-[#161616]"
      style={{ scrollSnapAlign: "start" }}
    >
      {/* Card image */}
      <div className="relative aspect-[63/88] w-full overflow-hidden rounded-t-2xl bg-[#0D0D0D]">
        {card.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.image_url}
            alt={card.name}
            className="h-full w-full object-cover object-center transition duration-200 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_65%)]">
            <p className="text-[10px] text-[#333]">No image</p>
          </div>
        )}
      </div>

      {/* Text content */}
      <div className="flex flex-1 flex-col p-2.5">
        {/* Card name */}
        <p className="line-clamp-2 text-[12px] font-semibold leading-tight text-[#E0E0E0] group-hover:text-[#F0F0F0]">
          {card.name}
        </p>

        {/* Set */}
        <p className="mt-0.5 truncate text-[10px] text-[#555]">
          {card.set_name ?? "Unknown set"}
        </p>

        {/* Price + trend */}
        <div className="mt-auto flex items-center gap-1 pt-2">
          <span className="text-[14px] font-bold tabular-nums text-[#F0F0F0]">
            {formatPrice(card.median_7d)}
          </span>
          <TrendArrow slope={card.trend_slope_7d} />
        </div>

        {/* Tier badge (movers only) */}
        {showTier && tier ? (
          <span
            className="mt-1.5 inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
            style={{ color: tier.color, backgroundColor: tier.bg }}
          >
            {tier.label}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
