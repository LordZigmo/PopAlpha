import Link from "next/link";
import type { HomepageCard } from "@/lib/data/homepage";
import ChangeBadge from "@/components/change-badge";

function formatPrice(n: number | null): string {
  if (n == null || n <= 0) return "--";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getConfidenceVisual(score: number | null, lowConfidence: boolean | null | undefined) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  if (lowConfidence || clamped < 55) {
    return {
      score: clamped,
      label: "Low",
      color: "#FF8A80",
      fill: "rgba(255,138,128,0.9)",
    };
  }
  if (clamped >= 85) {
    return {
      score: clamped,
      label: "High",
      color: "#63D471",
      fill: "rgba(99,212,113,0.95)",
    };
  }
  if (clamped >= 70) {
    return {
      score: clamped,
      label: "Solid",
      color: "#7DD3FC",
      fill: "rgba(125,211,252,0.95)",
    };
  }
  return {
    score: clamped,
    label: "Watch",
    color: "#FACC15",
    fill: "rgba(250,204,21,0.95)",
  };
}

export default function CardTileMini({
  card,
}: {
  card: HomepageCard;
}) {
  const confidence = getConfidenceVisual(card.confidence_score, card.low_confidence);
  const filledSegments = confidence
    ? confidence.score >= 85
      ? 4
      : confidence.score >= 70
        ? 3
        : confidence.score >= 55
          ? 2
          : 1
    : 0;

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
              className="h-full w-full object-cover object-center transition-transform duration-300 group-hover:scale-[1.03]"
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

        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-bold tabular-nums text-[#F0F0F0]">
              {formatPrice(card.market_price)}
            </span>
          </div>
          <div className="shrink-0 pt-0.5">
            <ChangeBadge pct={card.change_pct} windowLabel={card.change_window} />
          </div>
        </div>

        {confidence ? (
          <div className="mt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8A8A8A]">
                Price Confidence
              </span>
              <span
                className="shrink-0 text-[11px] font-semibold tabular-nums"
                style={{ color: confidence.color }}
              >
                {confidence.label} {confidence.score}
              </span>
            </div>
            <div
              className="mt-1 flex gap-1"
              aria-label={`Price confidence ${confidence.score} out of 100`}
            >
              {Array.from({ length: 4 }, (_, index) => (
                <span
                  key={index}
                  className="h-1.5 flex-1 rounded-full"
                  style={{
                    backgroundColor: index < filledSegments ? confidence.fill : "rgba(255,255,255,0.07)",
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Link>
  );
}
