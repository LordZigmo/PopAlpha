"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";

import CanonicalCardFloatingHero from "@/components/canonical-card-floating-hero";
import CardMarketIntelClient from "@/components/card-market-intel-client";
import CardModeToggle from "@/components/card-mode-toggle";
import { Pill } from "@/components/ios-grouped-ui";
import PersonalizedCardInsight from "@/components/personalized-card-insight";
import PopAlphaScoutPreview from "@/components/popalpha-scout-preview";
import type { FinishGroup } from "@/lib/cards/detail-types";
import type { RawCardMarketVariant } from "@/components/raw-card-variant-types";
import {
  PRICING_DISPLAY_V2_ENABLED,
  formatPriceDisplay,
  resolveDisplayedMarketPrice,
} from "@/lib/pricing/displayed-market-price";
import { priceObservationDensityLabel } from "@/lib/pricing/price-observation-density";

type RawCardMarketSurfaceProps = {
  canonicalSlug: string;
  canonicalName: string;
  subtitleText: string;
  setName: string | null;
  cardNumber: string | null;
  canonicalSetHref: string | null;
  variants: RawCardMarketVariant[];
  finishGroups: FinishGroup[];
  selectedPrintingId: string | null;
  selectedWindow: "7d" | "30d" | "90d";
  rawHref: string;
  gradedHref: string;
  scoutSummaryText: string | null;
  scoutUpdatedAt: string | null;
  isPro: boolean;
  personalizedVariantRef: string | null;
  children?: ReactNode;
};

function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatAsOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Pin to UTC so the server (UTC) and client (viewer's local TZ) render the
  // identical string — a tz-relative toLocaleString here is a second source of
  // React #418 hydration mismatches for any non-UTC visitor. Matches the
  // UTC-pinned pattern already used in view-history-chart.tsx.
  return `${date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function rarityColor(rarity: string | null): { label: string; color: string; borderColor: string; bgColor: string } | null {
  if (!rarity) return null;
  const normalized = rarity.toLowerCase();
  if (normalized === "common") return { label: "Common", color: "#D0D0D0", borderColor: "rgba(208,208,208,0.25)", bgColor: "rgba(208,208,208,0.06)" };
  if (normalized === "uncommon") return { label: "Uncommon", color: "#4ADE80", borderColor: "rgba(74,222,128,0.25)", bgColor: "rgba(74,222,128,0.06)" };
  if (normalized === "rare" || normalized.includes("rare")) return { label: rarity, color: "#60A5FA", borderColor: "rgba(96,165,250,0.25)", bgColor: "rgba(96,165,250,0.06)" };
  if (normalized.includes("mythic") || normalized.includes("very rare") || normalized.includes("illustration") || normalized === "promo") {
    return { label: rarity, color: "#C084FC", borderColor: "rgba(192,132,252,0.25)", bgColor: "rgba(192,132,252,0.06)" };
  }
  if (normalized.includes("legend") || normalized.includes("hyper") || normalized.includes("secret") || normalized.includes("special art") || normalized === "sar") {
    return { label: rarity, color: "#FB923C", borderColor: "rgba(251,146,60,0.25)", bgColor: "rgba(251,146,60,0.06)" };
  }
  return { label: rarity, color: "#999", borderColor: "rgba(153,153,153,0.25)", bgColor: "rgba(153,153,153,0.06)" };
}

function marketStatusSignal(active7d: number | null): { label: string; tone: "positive" | "warning" | "neutral" } {
  return priceObservationDensityLabel(active7d);
}

function updatePrintingParam(nextPrintingId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("printing", nextPrintingId);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function RawCardMarketSurface({
  canonicalSlug,
  canonicalName,
  subtitleText,
  setName,
  cardNumber,
  canonicalSetHref,
  variants,
  finishGroups,
  selectedPrintingId,
  selectedWindow,
  rawHref,
  gradedHref,
  scoutSummaryText,
  scoutUpdatedAt,
  isPro,
  personalizedVariantRef,
  children,
}: RawCardMarketSurfaceProps) {
  const [userPrintingId, setUserPrintingId] = useState<string | null>(null);
  const userSelectedVariant = userPrintingId
    ? variants.find((variant) => variant.printingId === userPrintingId) ?? null
    : null;
  const activePrintingId = userSelectedVariant?.printingId ?? selectedPrintingId ?? variants[0]?.printingId ?? null;

  const activeVariant =
    variants.find((variant) => variant.printingId === activePrintingId)
    ?? variants[0]
    ?? null;

  const currentPrice = activeVariant?.currentPrice ?? null;
  const fairValue = activeVariant?.marketBalancePrice ?? null;
  const priceChangePct = activeVariant?.changePct7d ?? null;
  const marketPriceDisplayState = activeVariant?.marketPriceDisplayState ?? null;
  const recentMarketSignalUsd = activeVariant?.recentMarketSignalUsd ?? null;
  const recentMarketSignalAsOf = activeVariant?.recentMarketSignalAsOf ?? null;
  const recentMarketSignalDirection = activeVariant?.recentMarketSignalDirection ?? null;
  const recentMarketSignalDeltaPct = activeVariant?.recentMarketSignalDeltaPct ?? null;
  const displayPrimaryPrice = currentPrice;
  const formattedAsOf = formatAsOf(activeVariant?.asOfTs ?? null);
  // Phase 2 of tiered-refresh: classify the price by age. Stale cards
  // get a "Last sold · {date}" label instead of "Near-mint market price".
  const heroPriceDisplay = PRICING_DISPLAY_V2_ENABLED
    ? resolveDisplayedMarketPrice({
        marketPrice: currentPrice,
        marketPriceAsOf: activeVariant?.asOfTs ?? null,
      })
    : null;
  const heroPriceMeta = heroPriceDisplay ? formatPriceDisplay(heroPriceDisplay) : null;
  const showPrimaryPrice = !heroPriceDisplay || heroPriceDisplay.kind !== "no_market";
  const primaryPrice = displayPrimaryPrice != null && showPrimaryPrice
    ? formatUsdCompact(displayPrimaryPrice)
    : null;
  const showPriceChange = !heroPriceDisplay || heroPriceMeta?.showChangeBadge === true;
  const scoutMarketPrice = showPriceChange ? currentPrice : null;
  const displayedPriceChangePct = showPriceChange ? priceChangePct : null;
  const heroPriceLabel = (() => {
    if (heroPriceDisplay?.kind === "stale_recent") {
      return `Last sold · ${heroPriceDisplay.ageLabel}`;
    }
    if (heroPriceDisplay?.kind === "stale_old") {
      return `Last sold · ${heroPriceDisplay.ageLabel} · Sparse market`;
    }
    if (heroPriceDisplay?.kind === "no_market") {
      return "No recent market";
    }
    const marketLabel = marketPriceDisplayState === "ALIGNED" ? "Aligned market price" : "Market Price";
    return formattedAsOf
      ? `${marketLabel} · Updated ${formattedAsOf}`
      : marketLabel;
  })();
  const showRecentMarketSignal = recentMarketSignalUsd !== null && recentMarketSignalDirection !== null;
  const recentMarketSignalDeltaLabel = recentMarketSignalDeltaPct != null
    ? `${Math.abs(recentMarketSignalDeltaPct) >= 10 ? Math.abs(recentMarketSignalDeltaPct).toFixed(0) : Math.abs(recentMarketSignalDeltaPct).toFixed(1)}%`
    : null;
  const recentMarketSignalCopy = showRecentMarketSignal
    ? `${recentMarketSignalDirection === "HIGHER" ? "higher" : "lower"}${recentMarketSignalDeltaLabel ? ` by ${recentMarketSignalDeltaLabel}` : ""}`
    : null;
  const priceChangeColor = displayedPriceChangePct == null
    ? "#6B6B6B"
    : displayedPriceChangePct > 0
      ? "#00DC5A"
      : displayedPriceChangePct < 0
        ? "#FF3B30"
        : "#6B6B6B";
  const edgePercent = currentPrice != null && fairValue != null && fairValue > 0
    ? ((currentPrice - fairValue) / fairValue) * 100
    : null;
  const edgeAbsPct = edgePercent !== null ? Math.abs(edgePercent) : null;
  const edgeFormatted = edgeAbsPct !== null
    ? `${edgeAbsPct >= 10 ? edgeAbsPct.toFixed(0) : edgeAbsPct.toFixed(1)}%`
    : null;
  const edgeLabel = edgePercent !== null
    ? edgePercent < -1 ? "Buyer's Edge" : edgePercent > 1 ? "Dealer's Edge" : null
    : null;
  const edgeColor = edgePercent !== null
    ? edgePercent < -1 ? "#00DC5A" : edgePercent > 1 ? "#FF3B30" : "#6B6B6B"
    : "#6B6B6B";
  const rarityInfo = rarityColor(activeVariant?.rarity ?? null);
  const marketStatus = marketStatusSignal(activeVariant?.activeListings7d ?? null);

  function handleVariantChange(nextPrintingId: string) {
    setUserPrintingId(nextPrintingId);
    updatePrintingParam(nextPrintingId);
  }

  return (
    <>
      <CanonicalCardFloatingHero
        imageUrl={activeVariant?.imageUrl ?? null}
        altText={canonicalName}
      />

      <div id="content" className="content-sheet">
        <div className="mx-auto max-w-5xl px-4 pb-[max(env(safe-area-inset-bottom),2.5rem)] pt-8 sm:px-6 sm:pb-[max(env(safe-area-inset-bottom),3.5rem)]">
          <div className="mb-6">
            <h1 className="text-[36px] font-semibold leading-tight tracking-[-0.035em] text-[#F0F0F0] sm:text-[44px]">
              {canonicalName}
            </h1>
            <p className="mt-1 text-[15px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B]">
              {subtitleText}
            </p>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {primaryPrice !== null ? (
                  <>
                    <div className="flex flex-wrap items-baseline gap-2.5">
                      <span className="text-[46px] font-bold leading-none tracking-[-0.04em] tabular-nums text-[#F0F0F0] sm:text-[56px]">
                        {primaryPrice}
                      </span>
                      {displayedPriceChangePct != null ? (
                        <span
                          className="text-[20px] font-bold tabular-nums tracking-[-0.02em] sm:text-[24px]"
                          style={{ color: priceChangeColor }}
                        >
                          {displayedPriceChangePct > 0 ? "+" : ""}
                          {Math.abs(displayedPriceChangePct) >= 10 ? displayedPriceChangePct.toFixed(0) : displayedPriceChangePct.toFixed(1)}%
                        </span>
                      ) : null}
                    </div>
                    {fairValue != null ? (
                      <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
                        <span className="text-[15px] text-[#6B6B6B]">
                          Fair Value <span className="font-semibold tabular-nums text-[#999]">{formatUsdCompact(fairValue)}</span>
                        </span>
                        {edgeLabel && edgeFormatted ? (
                          <span
                            className="inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] font-semibold"
                            style={{
                              color: edgeColor,
                              borderColor: edgePercent != null && edgePercent < -1 ? "rgba(0,220,90,0.25)" : edgePercent != null && edgePercent > 1 ? "rgba(255,59,48,0.25)" : "rgba(107,107,107,0.25)",
                              backgroundColor: edgePercent != null && edgePercent < -1 ? "rgba(0,220,90,0.08)" : edgePercent != null && edgePercent > 1 ? "rgba(255,59,48,0.08)" : "transparent",
                            }}
                          >
                            {edgeFormatted} {edgeLabel}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <p className="mt-1 text-[14px] text-[#555]">
                      {heroPriceLabel}
                    </p>
                    {showRecentMarketSignal ? (
                      <div className="mt-1 text-[13px] tabular-nums text-[#7A7A7A]">
                        <p>
                          Recent market signal: {formatUsdCompact(recentMarketSignalUsd)}{" "}
                          <span className="text-[#5E5E5E]">
                            {recentMarketSignalCopy}
                            {recentMarketSignalAsOf ? ` · Updated ${formatAsOf(recentMarketSignalAsOf) ?? "--"}` : ""}
                          </span>
                        </p>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="text-[15px] text-[#6B6B6B]">Market data is still forming for this variant.</p>
                )}
              </div>
              <div className="shrink-0">
                <CardModeToggle
                  activeMode="RAW"
                  rawHref={rawHref}
                  gradedHref={gradedHref}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {activeVariant?.descriptorLabel ? (
                  <Pill label={activeVariant.descriptorLabel} tone="metallic" />
                ) : null}
                {rarityInfo ? (
                  <span
                    className="inline-flex min-h-8 items-center rounded-full border px-3 text-[14px] font-semibold"
                    style={{ color: rarityInfo.color, borderColor: rarityInfo.borderColor, backgroundColor: rarityInfo.bgColor }}
                  >
                    {rarityInfo.label}
                  </span>
                ) : null}
                {!activeVariant?.descriptorLabel ? (
                  <>
                    {setName && canonicalSetHref ? (
                      <Link
                        href={canonicalSetHref}
                        className="inline-flex min-h-7 items-center rounded-full border border-[#1E1E1E] bg-white/[0.04] px-3 text-[15px] font-semibold text-[#999]"
                      >
                        {setName}
                      </Link>
                    ) : null}
                    {cardNumber ? <Pill label={`#${cardNumber}`} tone="neutral" /> : null}
                  </>
                ) : null}
              </div>
              {activeVariant?.activeListings7d != null ? (
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Pill label={marketStatus.label} tone={marketStatus.tone} />
                </div>
              ) : null}
            </div>
          </div>

          <PopAlphaScoutPreview
            cardName={canonicalName}
            marketPrice={scoutMarketPrice}
            fairValue={fairValue}
            changePct={displayedPriceChangePct}
            changeLabel={displayedPriceChangePct != null ? "7d" : null}
            activeListings7d={activeVariant?.activeListings7d ?? null}
            summaryText={scoutSummaryText}
            updatedAt={scoutUpdatedAt}
            isPro={isPro}
          />

          <PersonalizedCardInsight
            canonicalSlug={canonicalSlug}
            variantRef={personalizedVariantRef}
            isPro={isPro}
          />

          <CardMarketIntelClient
            variants={variants}
            finishGroups={finishGroups}
            selectedPrintingId={activeVariant?.printingId ?? null}
            selectedWindow={selectedWindow}
            onVariantChange={handleVariantChange}
          />

          {children}
        </div>
      </div>
    </>
  );
}
