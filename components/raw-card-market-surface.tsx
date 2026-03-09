"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

import CanonicalCardFloatingHero from "@/components/canonical-card-floating-hero";
import CardMarketIntelClient from "@/components/card-market-intel-client";
import CardModeToggle from "@/components/card-mode-toggle";
import { Pill } from "@/components/ios-grouped-ui";
import MarketPulse from "@/components/market-pulse";
import PokeTraceBetaCard from "@/components/poketrace-beta-card";
import PopAlphaScoutPreview from "@/components/popalpha-scout-preview";
import type { RawCardMarketVariant } from "@/components/raw-card-variant-types";

type RawCardMarketSurfaceProps = {
  canonicalSlug: string;
  canonicalName: string;
  subtitleText: string;
  setName: string | null;
  cardNumber: string | null;
  canonicalSetHref: string | null;
  variants: RawCardMarketVariant[];
  selectedPrintingId: string | null;
  selectedWindow: "7d" | "30d" | "90d";
  rawHref: string;
  gradedHref: string;
  scoutSummaryText: string | null;
  scoutUpdatedAt: string | null;
  currentCardPulse: {
    bullishVotes: number;
    bearishVotes: number;
    userVote: "up" | "down" | null;
    resolvesAt: number | null;
  } | null;
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
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSignalScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Forming";
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
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
  if (active7d === null || active7d === undefined) return { label: "Market Forming", tone: "neutral" };
  if (active7d <= 4) return { label: "Scarce", tone: "positive" };
  return { label: "Abundant", tone: "neutral" };
}

function updatePrintingParam(nextPrintingId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("printing", nextPrintingId);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function DerivedMetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const toneClass = tone === "positive"
    ? "border-emerald-400/12 bg-emerald-400/[0.04] text-emerald-100"
    : tone === "negative"
      ? "border-red-400/12 bg-red-400/[0.04] text-red-100"
      : "border-white/[0.06] bg-white/[0.03] text-[#F0F0F0]";

  const subToneClass = tone === "positive"
    ? "text-emerald-200/70"
    : tone === "negative"
      ? "text-red-200/70"
      : "text-[#777]";

  return (
    <div className={`rounded-[20px] border px-4 py-3 backdrop-blur-sm ${toneClass}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${subToneClass}`}>
        {label}
      </p>
      <p className="mt-1 text-[18px] font-semibold tracking-[-0.02em]">
        {value}
      </p>
    </div>
  );
}

export default function RawCardMarketSurface({
  canonicalSlug,
  canonicalName,
  subtitleText,
  setName,
  cardNumber,
  canonicalSetHref,
  variants,
  selectedPrintingId,
  selectedWindow,
  rawHref,
  gradedHref,
  scoutSummaryText,
  scoutUpdatedAt,
  currentCardPulse,
  children,
}: RawCardMarketSurfaceProps) {
  const [activePrintingId, setActivePrintingId] = useState<string | null>(selectedPrintingId ?? variants[0]?.printingId ?? null);

  useEffect(() => {
    setActivePrintingId(selectedPrintingId ?? variants[0]?.printingId ?? null);
  }, [selectedPrintingId, variants]);

  const activeVariant =
    variants.find((variant) => variant.printingId === activePrintingId)
    ?? variants[0]
    ?? null;

  const currentPrice = activeVariant?.currentPrice ?? null;
  const fairValue = activeVariant?.marketBalancePrice ?? null;
  const priceChangePct = activeVariant?.changePct7d ?? null;
  const displayPrimaryPrice = currentPrice;
  const primaryPrice = displayPrimaryPrice != null ? formatUsdCompact(displayPrimaryPrice) : null;
  const formattedAsOf = formatAsOf(activeVariant?.asOfTs ?? null);
  const priceChangeColor = priceChangePct == null
    ? "#6B6B6B"
    : priceChangePct > 0
      ? "#00DC5A"
      : priceChangePct < 0
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
  const trendMetricValue = formatSignalScore(priceChangePct);
  const breakoutMetricValue = activeVariant?.activeListings7d != null
    ? activeVariant.activeListings7d <= 4
      ? "Tight Supply"
      : activeVariant.activeListings7d <= 10
        ? "Building"
        : "Crowded"
    : "Forming";
  const valueMetricValue = edgeLabel && edgeFormatted
    ? `${edgeFormatted} ${edgeLabel}`
    : fairValue != null
      ? `Fair ${formatUsdCompact(fairValue)}`
      : "Forming";

  function handleVariantChange(nextPrintingId: string) {
    setActivePrintingId(nextPrintingId);
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
                      {priceChangePct != null ? (
                        <span
                          className="text-[20px] font-bold tabular-nums tracking-[-0.02em] sm:text-[24px]"
                          style={{ color: priceChangeColor }}
                        >
                          {priceChangePct > 0 ? "+" : ""}
                          {Math.abs(priceChangePct) >= 10 ? priceChangePct.toFixed(0) : priceChangePct.toFixed(1)}%
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
                      {formattedAsOf ? `Near-mint market price · Updated ${formattedAsOf}` : "Near-mint market price"}
                    </p>
                    {(activeVariant?.justtcgPrice != null || activeVariant?.scrydexPrice != null) ? (
                      <div className="mt-1 text-[13px] tabular-nums text-[#7A7A7A]">
                        <p>
                          JustTCG: {activeVariant?.justtcgPrice != null ? formatUsdCompact(activeVariant.justtcgPrice) : "—"}{" "}
                          <span className="text-[#5E5E5E]">Updated: {formatAsOf(activeVariant?.justtcgAsOfTs ?? null) ?? "--"}</span>
                        </p>
                        <p>
                          Scrydex: {activeVariant?.scrydexPrice != null ? formatUsdCompact(activeVariant.scrydexPrice) : "—"}{" "}
                          <span className="text-[#5E5E5E]">Updated: {formatAsOf(activeVariant?.scrydexAsOfTs ?? null) ?? "--"}</span>
                        </p>
                      </div>
                    ) : null}
                    <PokeTraceBetaCard
                      slug={canonicalSlug}
                      printingId={activeVariant?.printingId ?? null}
                    />
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
            marketPrice={currentPrice}
            fairValue={fairValue}
            changePct={priceChangePct}
            changeLabel={priceChangePct != null ? "7d" : null}
            activeListings7d={activeVariant?.activeListings7d ?? null}
            summaryText={scoutSummaryText}
            updatedAt={scoutUpdatedAt}
          />

          <section className="mt-6 mb-6 grid gap-2 sm:grid-cols-3">
            <DerivedMetricTile
              label="Trend"
              value={trendMetricValue}
              tone={priceChangePct != null ? (priceChangePct > 0 ? "positive" : priceChangePct < 0 ? "negative" : "neutral") : "neutral"}
            />
            <DerivedMetricTile
              label="Breakout"
              value={breakoutMetricValue}
              tone={activeVariant?.activeListings7d != null && activeVariant.activeListings7d <= 4 ? "positive" : "neutral"}
            />
            <DerivedMetricTile
              label="Value"
              value={valueMetricValue}
              tone={edgePercent != null ? (edgePercent < -1 ? "positive" : edgePercent > 1 ? "negative" : "neutral") : "neutral"}
            />
          </section>

          <CardMarketIntelClient
            variants={variants}
            selectedPrintingId={activeVariant?.printingId ?? null}
            selectedWindow={selectedWindow}
            onVariantChange={handleVariantChange}
          />

          {currentCardPulse ? (
            <MarketPulse
              canonicalSlug={canonicalSlug}
              cardName={canonicalName}
              setName={setName}
              imageUrl={activeVariant?.imageUrl ?? null}
              changePct={priceChangePct}
              bullishVotes={currentCardPulse.bullishVotes}
              bearishVotes={currentCardPulse.bearishVotes}
              userVote={currentCardPulse.userVote}
              resolvesAt={currentCardPulse.resolvesAt}
            />
          ) : null}

          {children}
        </div>
      </div>
    </>
  );
}
