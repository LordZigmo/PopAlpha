"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import type { HomepageCard } from "@/lib/data/homepage";
import ChangeBadge from "@/components/change-badge";

const TIER_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  hot: { label: "Hot", color: "#FFB86B", bg: "rgba(255,184,107,0.1)" },
  warming: { label: "Warming", color: "#FFD60A", bg: "rgba(255,214,10,0.08)" },
  cooling: { label: "Cooling", color: "#64D2FF", bg: "rgba(100,210,255,0.08)" },
  cold: { label: "Cold", color: "#FF3B30", bg: "rgba(255,59,48,0.08)" },
};

function formatPrice(n: number | null): string {
  if (n == null || n <= 0) return "--";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="h-5 w-12 rounded-full bg-white/[0.03]" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 44;
      const y = 16 - ((value - min) / range) * 12;
      return `${x},${y}`;
    })
    .join(" ");

  const rising = values[values.length - 1] >= values[0];

  return (
    <svg viewBox="0 0 44 18" className="h-5 w-12 overflow-visible" aria-hidden="true">
      <polyline
        fill="none"
        stroke={rising ? "#7DD3FC" : "#94A3B8"}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function HotMarker() {
  return (
    <motion.span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[rgba(255,132,68,0.12)] text-[#FF9A5F]"
      animate={{ scale: [1, 1.08, 1], rotate: [0, -5, 4, 0] }}
      transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
      aria-label="Hot"
      title="Hot"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
        <path d="M13.6 2.3c.5 2.4-.6 4-1.7 5.5-.9 1.2-1.7 2.3-1.7 3.9 0 1.5.9 2.7 2.5 2.7 2.2 0 3.9-1.9 3.9-4.6 0-1.3-.5-2.8-1.8-4.4 3.7 1.6 5.8 5 5.8 8.7 0 4.5-3.4 7.6-8 7.6-4.4 0-7.6-2.9-7.6-7 0-3.4 2-5.7 4.6-7.8 1.4-1.1 2.8-2.3 4-4.6Z" />
      </svg>
    </motion.span>
  );
}

export default function CardTileMini({
  card,
  showTier = false,
}: {
  card: HomepageCard;
  showTier?: boolean;
}) {
  const tier = card.mover_tier ? TIER_STYLES[card.mover_tier] : null;
  const showHotPremium = showTier && card.mover_tier === "hot";

  return (
    <Link
      href={`/c/${encodeURIComponent(card.slug)}`}
      className="group flex w-[172px] shrink-0 flex-col lg:w-auto"
      style={{ scrollSnapAlign: "start" }}
    >
      <div className="relative overflow-hidden rounded-[1.05rem] p-[1px]">
        <div className="pointer-events-none absolute inset-0 rounded-[1.05rem] bg-[linear-gradient(135deg,rgba(125,211,252,0.72),rgba(255,255,255,0.08),rgba(96,165,250,0.52))] opacity-0 transition duration-300 group-hover:opacity-100" />
        <div className="relative aspect-[63/88] w-full overflow-hidden rounded-[1rem] bg-[#0D0D0D]">
          {card.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.image_url}
              alt={card.name}
              className="h-full w-full object-cover object-center transition duration-300 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_65%)]">
              <p className="text-[11px] text-[#333]">No image</p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-col">
        <p className="line-clamp-2 text-[14px] font-bold leading-tight text-[#ECECEC] group-hover:text-white">
          {card.name}
        </p>

        <p className="mt-0.5 truncate text-sm text-zinc-500">
          {card.set_name ?? "Unknown set"}
        </p>

        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[14px] font-bold tabular-nums text-[#F0F0F0]">
            {formatPrice(card.market_price)}
          </span>
          {showHotPremium ? (
            <>
              <HotMarker />
              <Sparkline values={card.sparkline_7d} />
            </>
          ) : null}
          <ChangeBadge pct={card.change_pct} windowLabel={card.change_window} />
        </div>

        {showTier && tier && !showHotPremium ? (
          <span
            className="mt-2 inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
            style={{ color: tier.color, backgroundColor: tier.bg }}
          >
            {tier.label}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
