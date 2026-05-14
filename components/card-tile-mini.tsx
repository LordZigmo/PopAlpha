import Link from "next/link";
import type { HomepageCard } from "@/lib/data/homepage";
import ChangeBadge from "@/components/change-badge";
import {
  PRICING_DISPLAY_V2_ENABLED,
  formatPriceDisplay,
  resolveDisplayedMarketPrice,
} from "@/lib/pricing/displayed-market-price";
import { selectJpPriceSource } from "@/lib/pricing/jp-price-source";

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
  // JP-source pick: if either Yahoo! JP or Snkrdunk has a price with
  // >= 3 samples, prefer the JP-native source over Scrydex's USD
  // reflection. Mirrors the iOS hero logic from PR #51 — confidence-
  // pick between the two sources (more samples = winner). When neither
  // qualifies, falls back to card.market_price (Scrydex) below.
  const jpSource = selectJpPriceSource({
    yahooJpPrice: card.yahoo_jp_price,
    yahooJpSampleCount: card.yahoo_jp_sample_count,
    snkrdunkPrice: card.snkrdunk_price,
    snkrdunkSampleCount: card.snkrdunk_sample_count,
  });

  // Phase 2 of tiered-refresh plan: classify the price by age so stale
  // cards stop pretending to be live. When the v2 flag is off, fall
  // through to the legacy "always show $X" behavior so we can disable
  // by env without redeploying.
  //
  // When jpSource is non-null we skip the staleness classifier — JP
  // sources have their own freshness model (sample count is the
  // confidence signal, not observed_at age) and we don't want the
  // "Last sold $X · Apr 28" wording on JP-source rows.
  const priceDisplay = PRICING_DISPLAY_V2_ENABLED && jpSource.source === null
    ? resolveDisplayedMarketPrice({
        marketPrice: card.market_price,
        marketPriceAsOf: card.updated_at,
      })
    : null;
  const priceMeta = priceDisplay ? formatPriceDisplay(priceDisplay) : null;

  const confidence = getConfidenceVisual(card.confidence_score, card.low_confidence);
  const showConfidence = confidence !== null && (priceMeta?.showConfidencePill ?? true);
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
            <span
              className={`block truncate font-bold tabular-nums ${
                priceMeta?.subdued ? "text-[#9CA3AF]" : "text-[#F0F0F0]"
              } ${priceMeta && priceDisplay?.kind !== "live" ? "text-[12px]" : "text-[14px]"}`}
              title={
                jpSource.source
                  ? `${jpSource.label} median · n=${jpSource.sampleCount} sales`
                  : priceDisplay?.kind === "stale_old"
                    ? "Sparse market — last sold price shown"
                    : undefined
              }
            >
              {jpSource.price != null
                ? formatPrice(jpSource.price)
                : priceMeta
                  ? priceMeta.label
                  : formatPrice(card.market_price)}
            </span>
            {/*
              Small source pill for JP-native rows so the user can see
              at a glance that this isn't Scrydex's USD reflection. Only
              renders when a JP source was picked.
            */}
            {jpSource.source ? (
              <span
                className="mt-1 inline-block rounded-full bg-[rgba(239,68,68,0.18)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#FCA5A5]"
                title={`Price from ${jpSource.label} (sold archive)`}
              >
                {jpSource.label}
              </span>
            ) : null}
          </div>
          {/*
            Change badge tracks Scrydex's change_pct, which isn't
            comparable to the JP-source median. Hide on JP-source rows
            (matches iOS suppressHeroChangeBadge logic from PR #51).
          */}
          {jpSource.source === null && (priceMeta?.showChangeBadge ?? true) ? (
            <div className="shrink-0 pt-0.5">
              <ChangeBadge pct={card.change_pct} windowLabel={card.change_window} />
            </div>
          ) : null}
        </div>

        {showConfidence && confidence ? (
          <div className="mt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8A8A8A]">
                Confidence
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
