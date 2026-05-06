/**
 * lib/pricing/displayed-market-price.ts
 *
 * Phase 2 of the tiered-refresh plan (2026-05-06). Single source of truth
 * for "what should we show the user as the price label" across every
 * surface. The 2026-05-05 audit found ~80% of catalog has prices >7 days
 * old; rendering them as if they were current ("$5.82" with no caveat)
 * is dishonest. This utility classifies a price into four kinds and
 * downstream components branch off of `kind`:
 *
 *   live          < 7d old           "$5.82" + change badge as today
 *   stale_recent  7-30d old          "Last sold $5.82 · Apr 28" — no badge
 *   stale_old     30-180d old        "Last sold $5.82 · Apr 2026" — subdued, no badge,
 *                                    "Sparse market" pill replaces confidence
 *   no_market     >180d, dormant tier, or null price → "—" + "No recent market"
 *
 * Inputs are nullable on purpose — many surfaces have partial data.
 * `refreshTier` is OPTIONAL; if absent, the kind switch uses age alone
 * (180d is the natural cutoff that tags everything dormant by default).
 *
 * Feature flag: NEXT_PUBLIC_PRICING_DISPLAY_V2_ENABLED. Default ON.
 * Set to "false" in env to fall back to legacy "always show price as
 * current" rendering.
 */

export type PriceDisplayKind = "live" | "stale_recent" | "stale_old" | "no_market";

export type RefreshTier = "hot" | "warm" | "sparse" | "dormant" | "unknown";

export type PriceDisplay =
  | { kind: "live"; price: number; asOf: string; ageDays: number }
  | { kind: "stale_recent"; price: number; asOf: string; ageDays: number; ageLabel: string }
  | { kind: "stale_old"; price: number; asOf: string; ageDays: number; ageLabel: string }
  | { kind: "no_market"; asOf: string | null };

const STALE_RECENT_DAYS = 7;
const STALE_OLD_DAYS = 30;
const NO_MARKET_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function resolveDisplayedMarketPrice(input: {
  marketPrice: number | null | undefined;
  marketPriceAsOf: string | null | undefined;
  refreshTier?: RefreshTier | string | null;
  now?: Date | number;
}): PriceDisplay {
  const nowMs =
    input.now instanceof Date
      ? input.now.getTime()
      : typeof input.now === "number"
        ? input.now
        : Date.now();

  const price =
    typeof input.marketPrice === "number" &&
    Number.isFinite(input.marketPrice) &&
    input.marketPrice > 0
      ? input.marketPrice
      : null;

  const asOf = typeof input.marketPriceAsOf === "string" ? input.marketPriceAsOf : null;

  if (input.refreshTier === "dormant" || price === null || asOf === null) {
    return { kind: "no_market", asOf };
  }

  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) {
    return { kind: "no_market", asOf };
  }

  const ageDays = Math.max(0, Math.floor((nowMs - asOfMs) / MS_PER_DAY));

  if (ageDays < STALE_RECENT_DAYS) return { kind: "live", price, asOf, ageDays };
  if (ageDays < STALE_OLD_DAYS) {
    return { kind: "stale_recent", price, asOf, ageDays, ageLabel: formatRecentAge(asOf) };
  }
  if (ageDays < NO_MARKET_DAYS) {
    return { kind: "stale_old", price, asOf, ageDays, ageLabel: formatOldAge(asOf) };
  }
  return { kind: "no_market", asOf };
}

function formatRecentAge(asOf: string): string {
  // "Apr 28"
  const d = new Date(asOf);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatOldAge(asOf: string): string {
  // "Apr 2026"
  const d = new Date(asOf);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatMoney(price: number): string {
  return `$${price.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Convenience formatter for components that just want the rendered string +
 * a few flags. Components needing more control should branch on
 * `display.kind` themselves.
 */
export function formatPriceDisplay(display: PriceDisplay): {
  label: string;
  subdued: boolean;
  showChangeBadge: boolean;
  showConfidencePill: boolean;
} {
  switch (display.kind) {
    case "live":
      return {
        label: formatMoney(display.price),
        subdued: false,
        showChangeBadge: true,
        showConfidencePill: true,
      };
    case "stale_recent":
      return {
        label: `Last sold ${formatMoney(display.price)} · ${display.ageLabel}`,
        subdued: false,
        showChangeBadge: false,
        showConfidencePill: false,
      };
    case "stale_old":
      return {
        label: `Last sold ${formatMoney(display.price)} · ${display.ageLabel}`,
        subdued: true,
        showChangeBadge: false,
        showConfidencePill: false,
      };
    case "no_market":
      return {
        label: "—",
        subdued: true,
        showChangeBadge: false,
        showConfidencePill: false,
      };
  }
}

/**
 * Feature flag — default on. Flip NEXT_PUBLIC_PRICING_DISPLAY_V2_ENABLED
 * to "false" in env to fall back to legacy "always show as live"
 * rendering across all surfaces. Server-readable as well as client.
 */
export const PRICING_DISPLAY_V2_ENABLED =
  process.env.NEXT_PUBLIC_PRICING_DISPLAY_V2_ENABLED !== "false";
