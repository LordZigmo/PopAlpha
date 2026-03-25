import Link from "next/link";
import { ArrowRight, BookOpen, Eye, Layers3, Radar, Rows3 } from "lucide-react";
import { Pill } from "@/components/ios-grouped-ui";
import type { HomepageCard } from "@/lib/data/homepage";

type ActionLink = {
  href: string;
  label: string;
  active?: boolean;
  icon: typeof Layers3;
};

type SectionLink = {
  href: string;
  label: string;
};

type PortfolioContext = {
  lots: number;
  units: number;
};

function formatPrice(value: string | null): string {
  return value ?? "—";
}

function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function RelatedCardLink({
  card,
}: {
  card: HomepageCard;
}) {
  return (
    <Link
      href={`/c/${encodeURIComponent(card.slug)}`}
      className="flex items-center gap-3 rounded-[1rem] border border-[#1E1E1E] bg-[#0B0B0B] px-3 py-3 text-[#D4D4D4] transition hover:border-white/[0.06] hover:text-white"
    >
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-[0.6rem] border border-white/[0.06] bg-white/[0.03]">
        {card.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.image_url} alt={card.name} className="h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold text-white">{card.name}</p>
        <p className="truncate text-[12px] text-[#6B7280]">{card.set_name ?? "Unknown set"}</p>
      </div>
      <span className="font-mono text-[12px] font-semibold text-[#E4E4E7]">
        {card.market_price != null ? `$${card.market_price.toFixed(card.market_price >= 10 ? 0 : 2)}` : "—"}
      </span>
    </Link>
  );
}

function RailAction({
  href,
  label,
  active = false,
  icon: Icon,
}: ActionLink) {
  return (
    <Link
      href={href}
      className={[
        "flex items-center gap-3 rounded-[1.1rem] border px-4 py-3 transition",
        active
          ? "border-white/[0.08] bg-white/[0.05] text-white"
          : "border-transparent bg-transparent text-[#B0B0B0] hover:border-white/[0.05] hover:bg-white/[0.03] hover:text-white",
      ].join(" ")}
    >
      <span
        className={[
          "flex h-10 w-10 items-center justify-center rounded-[0.9rem] border",
          active
            ? "border-white/[0.08] bg-white/[0.06] text-white"
            : "border-[#1E1E1E] bg-[#0B0B0B] text-[#6B7280]",
        ].join(" ")}
      >
        <Icon size={18} strokeWidth={2.1} />
      </span>
      <span className="text-[15px] font-semibold">{label}</span>
    </Link>
  );
}

function SectionJump({
  href,
  label,
}: SectionLink) {
  return (
    <a
      href={href}
      className="flex items-center justify-between rounded-[1rem] border border-[#1E1E1E] bg-[#0B0B0B] px-3 py-3 text-[13px] font-medium text-[#B0B0B0] transition hover:border-white/[0.06] hover:text-white"
    >
      <span>{label}</span>
      <ArrowRight size={14} />
    </a>
  );
}

export default function CanonicalCardContextRail({
  canonicalName,
  subtitleText,
  imageUrl,
  selectedPrintingLabel,
  primaryPrice,
  primaryPriceLabel,
  marketStatusLabel,
  marketStatusTone,
  rawHref,
  gradedHref,
  viewMode,
  canonicalSetHref,
  totalViews,
  activeListings7d,
  bullishVotes,
  bearishVotes,
  portfolioContext,
  isSignedIn,
  sectionLinks,
  relatedFromSet,
  relatedFromPokemon,
}: {
  canonicalName: string;
  subtitleText: string;
  imageUrl: string | null;
  selectedPrintingLabel: string | null;
  primaryPrice: string | null;
  primaryPriceLabel: string;
  marketStatusLabel: string;
  marketStatusTone: "neutral" | "positive" | "warning";
  rawHref: string;
  gradedHref: string;
  viewMode: "RAW" | "GRADED";
  canonicalSetHref: string | null;
  totalViews: number;
  activeListings7d: number | null;
  bullishVotes: number;
  bearishVotes: number;
  portfolioContext: PortfolioContext | null;
  isSignedIn: boolean;
  sectionLinks: SectionLink[];
  relatedFromSet: HomepageCard[];
  relatedFromPokemon: HomepageCard[];
}) {
  const actionLinks: ActionLink[] = [
    { href: rawHref, label: "Raw View", active: viewMode === "RAW", icon: Radar },
    { href: gradedHref, label: "Graded View", active: viewMode === "GRADED", icon: Layers3 },
    ...(canonicalSetHref ? [{ href: canonicalSetHref, label: "Set Page", icon: BookOpen }] : []),
    { href: "#live-listings", label: "Live Listings", icon: Rows3 },
  ];

  const topSetCards = relatedFromSet.slice(0, 3);
  const topPokemonCards = relatedFromPokemon.slice(0, 3);

  return (
    <div className="px-5 py-6">
      <section className="rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Card Context</p>
        <div className="mt-4 flex items-center gap-4">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-[1rem] border border-white/[0.06] bg-white/[0.03]">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt={canonicalName} className="h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="min-w-0">
            <p className="line-clamp-2 text-[16px] font-semibold text-white">{canonicalName}</p>
            <p className="mt-1 line-clamp-2 text-[12px] uppercase tracking-[0.12em] text-[#6B7280]">{subtitleText}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill label={marketStatusLabel} tone={marketStatusTone} size="small" />
              {selectedPrintingLabel ? <Pill label={selectedPrintingLabel} tone="metallic" size="small" /> : null}
            </div>
          </div>
        </div>
        <div className="mt-4">
          <p className="text-[24px] font-bold tracking-[-0.03em] text-white">{formatPrice(primaryPrice)}</p>
          <p className="mt-1 text-[12px] leading-5 text-[#6B7280]">{primaryPriceLabel}</p>
        </div>
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-4">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Quick Actions</p>
        <div className="mt-3 space-y-1.5">
          {actionLinks.map((link) => (
            <RailAction key={`${link.label}-${link.href}`} {...link} />
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Collection Relevance</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B7280]">Views</p>
            <p className="mt-2 text-[18px] font-semibold text-white">{formatCount(totalViews)}</p>
          </div>
          <div className="rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B7280]">Listings</p>
            <p className="mt-2 text-[18px] font-semibold text-white">{formatCount(activeListings7d)}</p>
          </div>
          <div className="rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B7280]">Bullish</p>
            <p className="mt-2 text-[18px] font-semibold text-white">{formatCount(bullishVotes)}</p>
          </div>
          <div className="rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B7280]">Bearish</p>
            <p className="mt-2 text-[18px] font-semibold text-white">{formatCount(bearishVotes)}</p>
          </div>
        </div>

        <div className="mt-4 rounded-[1rem] border border-white/[0.06] bg-[#0B0B0B] px-4 py-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">
            <Eye size={14} />
            Portfolio
          </div>
          {isSignedIn ? (
            portfolioContext && portfolioContext.units > 0 ? (
              <p className="mt-2 text-[14px] text-[#D4D4D4]">
                You already track <span className="font-semibold text-white">{portfolioContext.units}</span> unit{portfolioContext.units === 1 ? "" : "s"} across{" "}
                <span className="font-semibold text-white">{portfolioContext.lots}</span> lot{portfolioContext.lots === 1 ? "" : "s"}.
              </p>
            ) : (
              <p className="mt-2 text-[14px] text-[#8A8A8A]">This card is not in your portfolio yet.</p>
            )
          ) : (
            <p className="mt-2 text-[14px] text-[#8A8A8A]">Sign in to see whether this card is already in your portfolio.</p>
          )}
        </div>
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-4">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">On Page</p>
        <div className="mt-3 space-y-2">
          {sectionLinks.map((link) => (
            <SectionJump key={link.href} {...link} />
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Related Navigation</p>
            <p className="mt-3 text-[15px] font-semibold text-white">Nearby Cards</p>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">From This Set</p>
            <div className="mt-2 space-y-2.5">
              {topSetCards.length > 0 ? topSetCards.map((card) => (
                <RelatedCardLink key={`set-${card.slug}`} card={card} />
              )) : (
                <div className="rounded-[1rem] border border-dashed border-white/[0.06] bg-[#0B0B0B] px-4 py-4 text-[13px] text-[#6B7280]">
                  No other tracked cards from this set yet.
                </div>
              )}
            </div>
          </div>

          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">From This Pokémon</p>
            <div className="mt-2 space-y-2.5">
              {topPokemonCards.length > 0 ? topPokemonCards.map((card) => (
                <RelatedCardLink key={`pokemon-${card.slug}`} card={card} />
              )) : (
                <div className="rounded-[1rem] border border-dashed border-white/[0.06] bg-[#0B0B0B] px-4 py-4 text-[13px] text-[#6B7280]">
                  No other tracked cards from this Pokémon yet.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
