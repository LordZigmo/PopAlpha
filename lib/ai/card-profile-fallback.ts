// Deterministic card-profile types, helpers, and fallback content.
//
// Lifted out of card-profile-summary.ts so unit tests can import this
// pure module without tripping the `import "server-only"` barrier on
// the LLM-call file. Nothing here touches the network, the database,
// or any framework — it's pricing math, narrative templates, and a
// tier classifier. card-profile-summary.ts re-exports the public
// surface so existing callers don't need to retarget their imports.

import crypto from "node:crypto";

import { getPopAlphaCardProfileModelId } from "@/lib/ai/model-config";
import { ABUNDANT_RAW_CARD_MAX_USD } from "@/lib/pricing/displayed-market-price";

// ── Constants ───────────────────────────────────────────────────────────────

// Default bulk profile model label. The server-only LLM path can override
// this for featured/high-priority cards while the pure fallback remains
// cheap and dependency-light.
export const CARD_PROFILE_MODEL_LABEL = getPopAlphaCardProfileModelId();

export const SIGNAL_LABELS = [
  "BREAKOUT",
  "COOLING",
  "VALUE_ZONE",
  "STEADY",
  "OVERHEATED",
] as const;
export type SignalLabel = (typeof SIGNAL_LABELS)[number];

export const VERDICTS = [
  "UNDERVALUED",
  "FAIR",
  "OVERHEATED",
  "INSUFFICIENT_DATA",
] as const;
export type Verdict = (typeof VERDICTS)[number];

// ── Low-dollar floor ─────────────────────────────────────────────────────────
//
// Cards at or below this price have markets too thin to narrate — a few cents
// reads as a huge % swing, and the cached LLM summary routinely froze a stale
// (sometimes contaminated) price (e.g. a $0.01 card serving "$0.86, -50%").
// Below the floor we emit a deterministic, honest note instead of a mover
// narrative — for EVERY generation path (cron, inline, LLM-fallback) and at
// read time (lib/card-profiles.ts neutralizes already-cached penny narratives
// with the identical content). One threshold, shared with the iOS hero's
// "Low-dollar card" treatment (ABUNDANT_RAW_CARD_MAX_USD).
export const LOW_DOLLAR_PROFILE_MAX_USD = ABUNDANT_RAW_CARD_MAX_USD;

export function isLowDollarProfile(marketPrice: number | null | undefined): boolean {
  return (
    typeof marketPrice === "number" &&
    Number.isFinite(marketPrice) &&
    marketPrice > 0 &&
    marketPrice <= LOW_DOLLAR_PROFILE_MAX_USD
  );
}

const LOW_DOLLAR_SUMMARY_SHORT =
  `Low-dollar card — under $${LOW_DOLLAR_PROFILE_MAX_USD}, the market's too thin to read a reliable trend, ` +
  `so we show the latest price rather than a signal.`;
const LOW_DOLLAR_SUMMARY_LONG =
  `${LOW_DOLLAR_SUMMARY_SHORT} At these levels a few cents reads as a big percentage swing, ` +
  `so we don't call a move we can't stand behind.`;

/**
 * Deterministic content for a low-dollar (≤ LOW_DOLLAR_PROFILE_MAX_USD) card.
 * Shared by the generation funnel (buildFallbackProfile) and the read-time
 * neutralizer (loadCardProfileDetail) so a penny card reads identically whether
 * its row was just generated or is a stale pre-floor cache. Neutral signal +
 * INSUFFICIENT_DATA verdict so no trend badge or move call is implied.
 */
export function lowDollarProfileContent(): {
  signalLabel: SignalLabel;
  verdict: Verdict;
  chip: string;
  summaryShort: string;
  summaryLong: string;
} {
  return {
    signalLabel: "STEADY",
    verdict: "INSUFFICIENT_DATA",
    chip: "💵 Low-dollar",
    summaryShort: LOW_DOLLAR_SUMMARY_SHORT,
    summaryLong: LOW_DOLLAR_SUMMARY_LONG,
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

export type CardProfileInput = {
  canonicalSlug: string;
  canonicalName: string;
  setName: string | null;
  cardNumber: string | null;
  marketPrice: number | null;
  // Freshest single observed sale (public_card_metrics.latest_price) + its date.
  // Fed to the model only as DATED, explicitly-non-current context — the Market
  // Price still leads as the only "current price". Optional so non-cron builders
  // of CardProfileInput can omit it (treated as absent → no freshest line).
  latestPrice?: number | null;
  latestPriceAsOf?: string | null;
  marketPriceDisplayState?: "ALIGNED" | "SIGNAL_HIGHER" | "SIGNAL_LOWER" | "PUBLIC_ONLY" | "UNDER_REVIEW" | "NO_RELIABLE_PRICE" | string | null;
  recentMarketSignalUsd?: number | null;
  recentMarketSignalAsOf?: string | null;
  recentMarketSignalDeltaPct?: number | null;
  recentMarketSignalDirection?: "HIGHER" | "LOWER" | string | null;
  median7d: number | null;
  median30d: number | null;
  changePct7d: number | null;
  low30d: number | null;
  high30d: number | null;
  // Rolled-up price-observation count over 7 days (DB column:
  // active_listings_7d). Defined as
  //   greatest(history_7d_count, snapshot_active_7d_count)
  // summed across printing variants — see migration
  // 20260304120000_refresh_card_metrics_use_history_counts.sql.
  // Dominated by data-provider price-history rows for popular cards
  // and uncapped (an earlier comment claiming a "*20-then-clamp" cap
  // was wrong — that cap is on liquidity_score). The absolute number
  // is not meaningful to a collector, so prompts and fallbacks
  // translate it to a qualitative bucket via priceTrackingBucket()
  // and never surface the raw count. NOT marketplace listings or
  // copies for sale.
  priceObservations7d: number | null;
  volatility30d: number | null;
  liquidityScore: number | null;
  conditionPrices: Array<{ condition: string; price: number }> | null;
  // Card-level metadata used by buildFallbackProfile() to produce
  // tier-aware copy for cheap cards. The LLM prompt currently ignores
  // these — they exist so the deterministic fallback can distinguish
  // "$0.30 Common from a 2024 set" (bulk) from "$0.30 obscure printing
  // of a 2003 chase" (vintage). All three may be null for cards that
  // pre-date the metadata RPC migration.
  rarity: string | null;
  year: number | null;
  isDigital: boolean | null;
  // Selection metadata from get_cards_needing_profile_refresh(). The
  // fallback copy does not use this, but the server-only LLM path uses
  // it to route featured/homepage-worthy cards to a stronger model.
  isHighPriority?: boolean | null;
};

export type CardProfileResult = {
  signalLabel: SignalLabel;
  verdict: Verdict;
  chip: string;
  summaryShort: string;
  summaryLong: string;
  source: "llm" | "fallback";
  modelLabel: string;
  inputTokens: number | null;
  outputTokens: number | null;
  metricsHash: string;
  // When source === "fallback", carries the reason the LLM path failed
  // so the caller (cron route) can report it instead of silently
  // writing 100% fallbacks and returning ok:true. See
  // docs/project_silent_rpc_fallbacks.md — same lesson.
  //   - "llm-threw:<error>" — generateText threw synchronously (auth,
  //     model-not-found, rate-limit, abort, etc.)
  //   - "parse-miss"         — LLM returned text but parseLlmProfile
  //     rejected the shape
  //   - undefined            — source === "llm", no failure
  failureReason?: string;
};

// ── Metrics hash ────────────────────────────────────────────────────────────
//
// The hash is the refresh trigger for the card-profile cron — when it
// changes, the card's LLM summary gets regenerated. So sensitivity
// here directly controls how often we pay for an LLM call per card,
// and by extension steady-state cost.
//
// Coarsened 2026-04-26 to bound steady-state cost. Prior version
// rounded prices to the cent and changePct to 0.1% — sensitive enough
// that pure noise (cent-level price ticks, percent-point reporting
// precision, day-edge poll-window flicker on activeListings) was
// triggering LLM refreshes for cards whose narrative was unchanged.
//
// What's in the hash now:
//   marketPrice / median7d / low30d / high30d  → rounded to whole dollars
//   changePct7d                                 → rounded to whole percent
//
// What was DROPPED:
//   priceObservations7d (DB column: active_listings_7d) — flickers from
//   rolling-window edge timing (a card's count can move ±1 just because
//   yesterday's poll fell outside the window today). Was triggering
//   pure-noise refreshes. Still passed to the LLM in the prompt for
//   qualitative reasoning context (thin/steady/dense bucket) — just
//   not used as a refresh trigger.
//
// Note on what priceObservations7d actually is: it's
//   greatest(history_7d_count, snapshot_active_7d_count)
// rolled up across all printing variants of the card (see migration
// 20260304120000_refresh_card_metrics_use_history_counts.sql lines
// 138-167). It is NOT capped — earlier comments in this file claimed a
// "*20-then-clamp" cap to 100, but that cap is on liquidity_score, not
// on this field. The number can run into the hundreds for popular
// cards with many variants, which is why we now translate it to a
// qualitative bucket (thin/steady/dense) before surfacing to users.
//
// Combined with changePct rounded to integers, this still catches:
//   - $0.50 → $1.00      (100% move; changePct flips 0 → 100)
//   - $20  → $21         (5% move;  changePct flips 0 → 5)
//   - $200 → $210        (same 5% logic at any price level)
// While suppressing:
//   - $4.97 → $4.98      (penny tick, narrative unchanged)
//   - 4.4% → 4.5%        (sub-percent move, within reporting precision)
//   - reads 14 → 15      (poll-edge flicker, no real activity change)

function round0(v: number | null): string {
  return v != null && Number.isFinite(v) ? Math.round(v).toString() : "";
}

export function buildMetricsHash(input: CardProfileInput): string {
  const payload = [
    round0(input.marketPrice),
    round0(input.median7d),
    round0(input.changePct7d),
    round0(input.low30d),
    round0(input.high30d),
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ── Deterministic signal/verdict (used by fallback and as a sanity guard) ───

export function pickSignal(input: CardProfileInput): SignalLabel {
  const change = input.changePct7d;
  const liquidity = input.liquidityScore;
  const volatility = input.volatility30d;

  if (typeof change === "number") {
    if (change >= 12) return "BREAKOUT";
    if (change <= -10) return "COOLING";
  }
  if (typeof volatility === "number" && volatility >= 35) return "OVERHEATED";

  // Value zone: priced in the lower half of the 30-day range with reasonable
  // liquidity — a soft "looks cheap, with depth" tag.
  if (
    typeof input.marketPrice === "number" &&
    typeof input.low30d === "number" &&
    typeof input.high30d === "number" &&
    input.high30d > input.low30d
  ) {
    const positionInRange =
      (input.marketPrice - input.low30d) / (input.high30d - input.low30d);
    if (positionInRange <= 0.35 && (liquidity ?? 0) >= 30) {
      return "VALUE_ZONE";
    }
  }

  return "STEADY";
}

export function pickVerdict(input: CardProfileInput, signal: SignalLabel): Verdict {
  if (input.marketPrice == null) return "INSUFFICIENT_DATA";
  if (signal === "BREAKOUT" || signal === "OVERHEATED") return "OVERHEATED";
  if (signal === "VALUE_ZONE") return "UNDERVALUED";
  return "FAIR";
}

export const SIGNAL_TO_CHIP: Record<SignalLabel, string> = {
  BREAKOUT: "🔥 Breakout",
  COOLING: "📉 Cooling Off",
  VALUE_ZONE: "💎 Good Buying Range",
  STEADY: "🔁 Holding Steady",
  OVERHEATED: "⚠️ Running Hot",
};

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "an unpriced level";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

// Translates the raw `priceObservations7d` count into a qualitative bucket.
// The raw number is technically meaningless to a reader (it's summed across
// printing variants over 7 days, with provider feeds dominating the count
// for popular cards). The bucket conveys the only thing that actually
// matters: how reliable today's price level is.
type PriceTrackingBucket = "thin" | "steady" | "dense";

export function priceTrackingBucket(count: number | null): PriceTrackingBucket | null {
  if (count == null || !Number.isFinite(count)) return null;
  if (count <= 4) return "thin";
  if (count < 30) return "steady";
  return "dense";
}

function formatSignedPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
}

function formatMarketSignalSentence(input: CardProfileInput): string | null {
  if (input.marketPrice == null || !Number.isFinite(input.marketPrice)) return null;
  const signalPrice = input.recentMarketSignalUsd;
  if (signalPrice == null || !Number.isFinite(signalPrice)) return null;
  const direction = input.recentMarketSignalDirection;
  if (direction !== "HIGHER" && direction !== "LOWER") return null;
  const directionText = direction === "HIGHER" ? "higher" : "lower";
  return `${input.canonicalName}'s Market Price is around ${formatUsd(input.marketPrice)}, while recent market signals are ${directionText} near ${formatUsd(signalPrice)}.`;
}

// ── Fallback tier classification ────────────────────────────────────────────
//
// For most of the catalog (cheap commons, set-completion fillers, dusty
// vintage), the LLM is cost-overkill — it'll keep ending up in the
// fallback path either because the cron deprioritizes them or because
// the metrics_hash never changes. So the fallback IS the product for
// these cards, and a generic "holding steady around $0.30" sentence
// fails them.
//
// The dispatcher below picks one of five tiers from the metadata that's
// already in CardProfileInput. The tier order is set so the more
// specific bucket wins:
//   digital        — Pokémon TCG Pocket / online-only cards
//   vintage_cheap  — older cards that aren't expensive (history, not hype)
//   bulk           — sub-$1 commons/uncommons (lot-sale territory)
//   set_completion — sub-$3 cards collectors grab to finish a set
//   mid_premium    — everything else (the LLM's actual sweet spot)
//
// "mid_premium" keeps the existing what's-happening / why-it-matters /
// what-to-watch pattern because (a) it's the LLM's sweet spot so this
// branch should rarely fire, (b) when it does fire here it's a real
// failure signal and the operator coverage view will surface that.

export type FallbackTier = "digital" | "vintage_cheap" | "bulk" | "set_completion" | "mid_premium";

// Rarity strings (case-insensitive) that disqualify a card from the
// "set completion filler" tier — these are chase cards, where a low
// price almost certainly means we don't have good market data, not
// that the card is genuinely unpopular.
const PREMIUM_RARITY_FRAGMENTS: readonly string[] = [
  "ultra rare",
  "secret",
  "hyper",
  "rainbow",
  "special illustration",
  "illustration rare",
  "promo",
];

function rarityIsPremium(rarity: string | null): boolean {
  if (!rarity) return false;
  const lower = rarity.toLowerCase();
  return PREMIUM_RARITY_FRAGMENTS.some((frag) => lower.includes(frag));
}

function rarityIsBulkEligible(rarity: string | null): boolean {
  if (!rarity) return true; // unknown rarity at < $1 is overwhelmingly bulk
  const lower = rarity.toLowerCase();
  return lower === "common" || lower === "uncommon";
}

export function identifyFallbackTier(input: CardProfileInput): FallbackTier {
  if (input.isDigital === true) return "digital";

  const price = input.marketPrice;
  const year = input.year;
  const rarity = input.rarity;

  // Vintage cheap: old card, not expensive. Wins over bulk/set-completion
  // because age is the more interesting framing — a $4 Skyridge Common
  // reads better as "vintage" than as "bulk".
  if (year != null && year < 2010 && price != null && price < 10) {
    return "vintage_cheap";
  }

  // Bulk: sub-$1 with bulk-eligible rarity.
  if (price != null && price < 1 && rarityIsBulkEligible(rarity)) {
    return "bulk";
  }

  // Set-completion: sub-$3, not a chase rarity. The price gate on its
  // own would catch too many cards (broken-data chase rares at $1
  // because of bad merging), so we exclude premium rarities explicitly.
  if (price != null && price < 3 && !rarityIsPremium(rarity)) {
    return "set_completion";
  }

  return "mid_premium";
}

// ── Sentence builders ───────────────────────────────────────────────────────

type Narrative = { happening: string; matters: string; watch: string };

// The original move-or-flat narrative used by the LLM's pre-2026-05
// fallback. Still the right content for mid/premium fallbacks — they're
// expensive enough to deserve the move framing, and they should rarely
// land here at all.
function buildMidPremiumNarrative(input: CardProfileInput, signal: SignalLabel): Narrative {
  const priceText = formatUsd(input.marketPrice);
  const changeText = formatSignedPct(input.changePct7d);
  const marketSignalSentence = formatMarketSignalSentence(input);

  let happening: string;
  if (marketSignalSentence) {
    happening = marketSignalSentence;
  } else if (changeText && input.changePct7d != null && input.changePct7d > 0) {
    happening = `${input.canonicalName} is up ${changeText} over the last 7 days, trading around ${priceText}.`;
  } else if (changeText && input.changePct7d != null && input.changePct7d < 0) {
    happening = `${input.canonicalName} is down ${changeText} over the last 7 days, trading around ${priceText}.`;
  } else {
    happening = `${input.canonicalName} is holding steady around ${priceText}.`;
  }

  let matters: string;
  switch (signal) {
    case "BREAKOUT":
      matters = "That is a strong move higher in a short window.";
      break;
    case "COOLING":
      matters = "That is a clear pullback from recent highs.";
      break;
    case "VALUE_ZONE":
      matters = "That puts it in a good buying range vs. the last 30 days.";
      break;
    case "OVERHEATED":
      matters = "Price swings have been bigger than usual lately.";
      break;
    default:
      matters = "There is no clear move in either direction right now.";
  }

  // The raw priceObservations7d count is a rolled-up data-provider
  // artifact (often in the dozens for popular cards) and means nothing
  // to a collector — translate to a qualitative bucket.
  const bucket = priceTrackingBucket(input.priceObservations7d);
  let watch: string;
  switch (bucket) {
    case "thin":
      watch = "Price tracking on this card is thin, so the next sale will tell you a lot.";
      break;
    case "steady":
      watch = "Price tracking is steady — watch whether the move holds across the next few sales.";
      break;
    case "dense":
      watch = "Price tracking is dense, so a clean move shows up fast — watch whether it holds across the next few sales.";
      break;
    default:
      watch = "Watch whether the move holds across the next few sales.";
  }

  return { happening, matters, watch };
}

function buildBulkNarrative(input: CardProfileInput): Narrative {
  const priceText = formatUsd(input.marketPrice);
  const setText = input.setName ? ` from ${input.setName}` : "";
  const rarityWord = input.rarity ? input.rarity.toLowerCase() : "card";
  const happening = `Bulk-tier ${rarityWord}${setText}.`;
  const matters = `Most copies trade around ${priceText} — typically pulled in lot sales and used to fill out a set or casual deck.`;
  const watch = "Worth more as part of a complete set than as a single — easy to find at local stores or in bulk lots.";
  return { happening, matters, watch };
}

function buildSetCompletionNarrative(input: CardProfileInput): Narrative {
  const priceText = formatUsd(input.marketPrice);
  const setName = input.setName;
  const happening = setName
    ? `Affordable card from ${setName}.`
    : "Affordable card with steady demand.";
  const matters = `Trades around ${priceText}.`;
  const watch = setName
    ? `Useful for collectors finishing the ${setName} set or filling a binder page.`
    : "Useful for collectors finishing a set or filling a binder page.";
  return { happening, matters, watch };
}

function buildVintageCheapNarrative(input: CardProfileInput): Narrative {
  const priceText = formatUsd(input.marketPrice);
  const setText = input.setName ? ` from ${input.setName}` : "";
  const yearText = input.year != null ? `${input.year}` : "older";
  const happening = `${yearText} card${setText}.`;
  const matters = `Trades around ${priceText} — light demand today but a piece of older TCG history.`;
  const watch = "Condition matters more than usual on cards this age — well-kept copies hold up best.";
  return { happening, matters, watch };
}

function buildDigitalNarrative(input: CardProfileInput): Narrative {
  const priceText = formatUsd(input.marketPrice);
  const setText = input.setName ? ` from ${input.setName}` : "";
  const happening = `Digital card${setText} (no physical print).`;
  const matters = `Tracked at around ${priceText}.`;
  const watch = "Pokémon TCG Pocket cards live in-app — not a physical collectible.";
  return { happening, matters, watch };
}

function buildTierNarrative(input: CardProfileInput, tier: FallbackTier, signal: SignalLabel): Narrative {
  switch (tier) {
    case "bulk":           return buildBulkNarrative(input);
    case "set_completion": return buildSetCompletionNarrative(input);
    case "vintage_cheap":  return buildVintageCheapNarrative(input);
    case "digital":        return buildDigitalNarrative(input);
    case "mid_premium":    return buildMidPremiumNarrative(input, signal);
  }
}

// Tier-flavored 3rd sentence for the high-mover override path. Reads
// natural at the end of a move-led paragraph: "Pikachu is up +25% over
// the last 7 days... That is a strong move higher... <flavor>."
function buildTierFlavoredWatch(input: CardProfileInput, tier: FallbackTier): string {
  switch (tier) {
    case "bulk":
      return "Even with the move, this is still bulk-tier territory — most copies trade in this range.";
    case "set_completion":
      return input.setName
        ? `Demand mostly comes from collectors finishing the ${input.setName} set.`
        : "Demand mostly comes from set-completion buyers, not specs.";
    case "vintage_cheap": {
      const yearText = input.year != null ? `${input.year} ` : "";
      const setText = input.setName ?? "older era";
      return `A ${yearText}${setText} card — niche demand, so a single move can read louder than the trend.`;
    }
    case "digital":
      return "Pokémon TCG Pocket cards live in-app — moves are scoped to that ecosystem.";
    case "mid_premium":
      // Should be unreachable — caller only calls this when tier is non-mid_premium.
      return "Watch whether the move holds across the next few sales.";
  }
}

export function buildFallbackProfile(input: CardProfileInput): CardProfileResult {
  // Low-dollar floor: the single funnel every path runs through (cron, inline
  // ensureMarketSignal, and the LLM path's fallback). A sub-$2 card gets the
  // deterministic honest note instead of a mover narrative — no fabricated
  // "80% decrease / fair valuation" on a nickel card.
  if (isLowDollarProfile(input.marketPrice)) {
    const c = lowDollarProfileContent();
    return {
      signalLabel: c.signalLabel,
      verdict: c.verdict,
      chip: c.chip,
      summaryShort: c.summaryShort,
      summaryLong: c.summaryLong,
      source: "fallback",
      modelLabel: CARD_PROFILE_MODEL_LABEL,
      inputTokens: null,
      outputTokens: null,
      metricsHash: buildMetricsHash(input),
    };
  }

  const signal = pickSignal(input);
  const verdict = pickVerdict(input, signal);
  const tier = identifyFallbackTier(input);
  const hasNotableMove =
    input.changePct7d != null && Math.abs(input.changePct7d) >= 10;

  let narrative: Narrative;
  if (tier === "mid_premium") {
    // Existing 3-step pattern — this is the LLM's sweet spot, and a
    // fallback here means the LLM actually failed (timeout, parse
    // miss, etc.). The operator coverage view + failure_reason buckets
    // are how we'd notice a regression here.
    narrative = buildMidPremiumNarrative(input, signal);
  } else if (hasNotableMove) {
    // Move-led narrative wins, but the watch line gets tier flavor so
    // a $0.80 bulk card up +25% reads as bulk-with-a-pop, not as a
    // generic mover.
    const moveLed = buildMidPremiumNarrative(input, signal);
    narrative = {
      happening: moveLed.happening,
      matters: moveLed.matters,
      watch: buildTierFlavoredWatch(input, tier),
    };
  } else {
    // Tier-led narrative for the long-tail steady cases.
    narrative = buildTierNarrative(input, tier, signal);
  }

  const summaryShort = `${narrative.happening} ${narrative.matters}`;
  const summaryLong = `${narrative.happening} ${narrative.matters} ${narrative.watch}`;

  return {
    signalLabel: signal,
    verdict,
    chip: SIGNAL_TO_CHIP[signal],
    summaryShort,
    summaryLong,
    source: "fallback",
    modelLabel: CARD_PROFILE_MODEL_LABEL,
    inputTokens: null,
    outputTokens: null,
    metricsHash: buildMetricsHash(input),
  };
}
