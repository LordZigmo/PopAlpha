import "server-only";

import crypto from "node:crypto";

import { dbAdmin } from "@/lib/db/admin";
import {
  buildFallbackProfile,
  buildMetricsHash as buildCardProfileMetricsHash,
  generateCardProfile,
  type CardProfileInput,
} from "@/lib/ai/card-profile-summary";

import { PROFILE_VERSION } from "../constants";
import { getPersonalizationCapability } from "../capability";
import {
  buildCollectorInsight,
  buildPersonalizedExplanation,
  type ExplanationCardInput,
  type MarketSignalContext,
} from "../explanation";
import type {
  Actor,
  CardStyleFeatures,
  CollectorInsight,
  CollectorSignals,
  PersonalizedExplanation,
  StyleProfile,
} from "../types";
import { assembleCollectorSignals } from "./collector-signals";

type CardProfileRow = {
  canonical_slug: string;
  signal_label: string | null;
  verdict: string | null;
  chip: string | null;
  summary_short: string | null;
  metrics_hash: string | null;
};

type CardMetricsRow = {
  market_price: number | null;
  market_price_display_state: string | null;
  recent_market_signal_usd: number | null;
  recent_market_signal_as_of: string | null;
  recent_market_signal_delta_pct: number | null;
  recent_market_signal_direction: "HIGHER" | "LOWER" | string | null;
  median_7d: number | null;
  median_30d: number | null;
  change_pct_7d: number | null;
  low_30d: number | null;
  high_30d: number | null;
  active_listings_7d: number | null;
  volatility_30d: number | null;
  liquidity_score: number | null;
};

type CanonicalCardRow = {
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
  is_digital: boolean | null;
};

function metricsHashFor(
  features: CardStyleFeatures,
  marketSignalHash: string | null,
): string {
  // Bake the per-card market signal into the cache key so a fresh BREAKOUT /
  // COOLING swap invalidates last week's read for the same user × card.
  const payload = [
    features.era,
    features.release_year ?? "",
    features.is_graded ? "g" : "r",
    features.liquidity_band,
    features.volatility_band,
    features.is_iconic ? "1" : "0",
    features.is_art_centric ? "1" : "0",
    features.is_mainstream ? "1" : "0",
    marketSignalHash ?? "",
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// Stable digest of the QUALITATIVE collector signals that shape the insight
// copy — saved / watchlisted / scanned / repeat-viewed card names, favorite
// sets, graded-vs-raw + language lean, and the collector type + traits.
// Folded into the Collector Insight cache key so a signal change that doesn't
// cross the coarse `dataConfidence` band (e.g. the user saves different cards
// or shifts favorite sets while staying "high") still invalidates a now-stale
// read for the same user × card. Volatile counters (eventCount, raw
// profileConfidence) are intentionally excluded so the cache isn't busted on
// every single behavior event.
function collectorSignalsDigest(signals: CollectorSignals): string {
  const payload = JSON.stringify([
    signals.collectorType,
    signals.supportingTraits,
    signals.savedCardNames,
    signals.watchlistCardNames,
    signals.scannedCardNames,
    signals.repeatedlyViewedCardNames,
    signals.favoriteSets,
    signals.gradedVsRawInterest,
    signals.languagePreference,
  ]);
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

async function readMarketSignal(
  canonicalSlug: string,
): Promise<{ context: MarketSignalContext | null; signalHash: string | null }> {
  try {
    const admin = dbAdmin();
    const [profileRes, metricsRes] = await Promise.all([
      admin
        .from("card_profiles")
        .select("canonical_slug, signal_label, verdict, chip, summary_short, metrics_hash")
        .eq("canonical_slug", canonicalSlug)
        .maybeSingle<CardProfileRow>(),
      admin
        .from("public_card_metrics")
        .select(
          "market_price, market_price_display_state, recent_market_signal_usd, recent_market_signal_as_of, recent_market_signal_delta_pct, recent_market_signal_direction, median_7d, median_30d, change_pct_7d, low_30d, high_30d, active_listings_7d, volatility_30d, liquidity_score",
        )
        .eq("canonical_slug", canonicalSlug)
        .is("printing_id", null)
        .eq("grade", "RAW")
        .maybeSingle<CardMetricsRow>(),
    ]);

    const profileRow = profileRes.data ?? null;
    const metricsRow = metricsRes.data ?? null;

    if (!profileRow && !metricsRow) {
      return { context: null, signalHash: null };
    }

    const context: MarketSignalContext = {
      signalLabel: profileRow?.signal_label ?? null,
      verdict: profileRow?.verdict ?? null,
      chip: profileRow?.chip ?? null,
      summaryShort: profileRow?.summary_short ?? null,
      marketPrice: metricsRow?.market_price ?? null,
      changePct7d: metricsRow?.change_pct_7d ?? null,
      // DB column is named active_listings_7d for historical reasons;
      // the value is fresh price observations, not marketplace listings.
      priceObservations7d: metricsRow?.active_listings_7d ?? null,
    };

    return { context, signalHash: profileRow?.metrics_hash ?? null };
  } catch {
    return { context: null, signalHash: null };
  }
}

/**
 * Inline market-signal fallback. Generates the per-card market summary
 * on demand and persists it to `card_profiles`, so the next viewer (and
 * the rest of the catalog) gets the cached read. Only called when the
 * combined-read prompt is about to fire and the row is missing.
 */
async function ensureMarketSignal(
  canonicalSlug: string,
): Promise<{ context: MarketSignalContext | null; signalHash: string | null }> {
  const existing = await readMarketSignal(canonicalSlug);
  if (existing.context && existing.context.signalLabel) return existing;

  // No row, or row exists without a signal_label (legacy). Try to build one.
  try {
    const admin = dbAdmin();
    const [canonicalRes, metricsRes, conditionsRes] = await Promise.all([
      admin
        .from("canonical_cards")
        .select("canonical_name, set_name, card_number, year, is_digital")
        .eq("slug", canonicalSlug)
        .maybeSingle<CanonicalCardRow>(),
      admin
        .from("public_card_metrics")
        .select(
          "market_price, market_price_display_state, recent_market_signal_usd, recent_market_signal_as_of, recent_market_signal_delta_pct, recent_market_signal_direction, median_7d, median_30d, change_pct_7d, low_30d, high_30d, active_listings_7d, volatility_30d, liquidity_score",
        )
        .eq("canonical_slug", canonicalSlug)
        .is("printing_id", null)
        .eq("grade", "RAW")
        .maybeSingle<CardMetricsRow>(),
      admin
        .from("card_condition_prices")
        .select("condition, price")
        .eq("canonical_slug", canonicalSlug),
    ]);

    const canonical = canonicalRes.data;
    const metrics = metricsRes.data;
    if (!canonical || !metrics || metrics.market_price == null) {
      return existing; // not enough data to build a signal
    }

    const conditionPrices =
      ((conditionsRes.data as Array<{ condition: string; price: number }> | null) ?? []).map(
        (r) => ({ condition: r.condition, price: Number(r.price) }),
      );

    const profileInput: CardProfileInput = {
      canonicalSlug,
      canonicalName: canonical.canonical_name,
      setName: canonical.set_name,
      cardNumber: canonical.card_number,
      marketPrice: metrics.market_price,
      marketPriceDisplayState: metrics.market_price_display_state,
      recentMarketSignalUsd: metrics.recent_market_signal_usd,
      recentMarketSignalAsOf: metrics.recent_market_signal_as_of,
      recentMarketSignalDeltaPct: metrics.recent_market_signal_delta_pct,
      recentMarketSignalDirection: metrics.recent_market_signal_direction,
      median7d: metrics.median_7d,
      median30d: metrics.median_30d,
      changePct7d: metrics.change_pct_7d,
      low30d: metrics.low_30d,
      high30d: metrics.high_30d,
      // active_listings_7d is the DB column name but the value is a count
      // of fresh price observations, not marketplace listings.
      priceObservations7d: metrics.active_listings_7d,
      volatility30d: metrics.volatility_30d,
      liquidityScore: metrics.liquidity_score,
      conditionPrices: conditionPrices.length > 0 ? conditionPrices : null,
      // year + is_digital are read on this fast-path. rarity lives on
      // card_printings (one card → many printings) and adding a 4th
      // round-trip just to flavor the deterministic fallback isn't
      // worth it on a path that mostly only fires for the very first
      // viewer of a brand-new card. The cron RPC supplies rarity on
      // refresh, so the next pass will upgrade the copy.
      rarity: null,
      year: canonical.year,
      isDigital: canonical.is_digital,
    };

    let result;
    try {
      result = await generateCardProfile(profileInput);
    } catch {
      result = buildFallbackProfile(profileInput);
    }

    // Persist so the next read hits cache. Best-effort — failure here
    // doesn't block the combined read since we still have `result`.
    try {
      await admin
        .from("card_profiles")
        .upsert(
          {
            canonical_slug: canonicalSlug,
            signal_label: result.signalLabel,
            verdict: result.verdict,
            chip: result.chip,
            summary_short: result.summaryShort,
            summary_long: result.summaryLong,
            source: result.source,
            model_label: result.modelLabel,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            metrics_hash: result.metricsHash,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "canonical_slug" },
        );
    } catch (err) {
      console.error("[personalization:explanation] inline market-signal upsert failed", err);
    }

    const context: MarketSignalContext = {
      signalLabel: result.signalLabel,
      verdict: result.verdict,
      chip: result.chip,
      summaryShort: result.summaryShort,
      marketPrice: profileInput.marketPrice,
      changePct7d: profileInput.changePct7d,
      priceObservations7d: profileInput.priceObservations7d,
    };
    const signalHash = buildCardProfileMetricsHash(profileInput);
    return { context, signalHash };
  } catch (err) {
    console.error("[personalization:explanation] ensureMarketSignal failed", err);
    return existing;
  }
}

// The cache table stores an opaque JSONB `payload` keyed by
// (actor_key, canonical_slug, profile_version, metrics_hash). Both the legacy
// PersonalizedExplanation and the structured CollectorInsight ride the same
// table; we keep them from colliding by namespacing the Collector Insight
// metrics_hash with a "ci:" prefix (see metricsHashFor / getCollectorInsight).
async function readCache<T>(
  actor: Actor,
  canonicalSlug: string,
  profileVersion: number,
  metricsHash: string,
): Promise<T | null> {
  try {
    const admin = dbAdmin();
    const { data, error } = await admin
      .from("personalization_explanation_cache")
      .select("payload")
      .eq("actor_key", actor.actor_key)
      .eq("canonical_slug", canonicalSlug)
      .eq("profile_version", profileVersion)
      .eq("metrics_hash", metricsHash)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data.payload as T;
  } catch {
    return null;
  }
}

async function writeCache<T>(
  actor: Actor,
  canonicalSlug: string,
  profileVersion: number,
  metricsHash: string,
  payload: T,
): Promise<void> {
  try {
    const admin = dbAdmin();
    await admin.from("personalization_explanation_cache").upsert(
      {
        actor_key: actor.actor_key,
        canonical_slug: canonicalSlug,
        profile_version: profileVersion,
        metrics_hash: metricsHash,
        payload,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "actor_key,canonical_slug,profile_version,metrics_hash" },
    );
  } catch (err) {
    console.error("[personalization:explanation] writeCache", err);
  }
}

/**
 * Get a personalized explanation for (actor, card). Honors the cache and
 * respects the capability mode (template vs. LLM).
 *
 * On the LLM path, the per-card market signal is fetched from `card_profiles`
 * and woven into the prompt. If that row is missing, we generate it inline
 * (one extra Gemini call on first view) so the combined read can speak to
 * the actual market state — coherence over a tiny latency hit.
 */
export async function getPersonalizedExplanation(
  actor: Actor,
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
): Promise<PersonalizedExplanation> {
  const capability = getPersonalizationCapability(actor);
  const profileVersion = profile?.version ?? PROFILE_VERSION;

  // Pull (or backfill) the market signal only on the LLM path. Template
  // path doesn't reason about market state, so it doesn't need it.
  let market: MarketSignalContext | null = null;
  let signalHash: string | null = null;
  if (capability.mode === "llm" && profile) {
    const fetched = await ensureMarketSignal(card.canonical_slug);
    market = fetched.context;
    signalHash = fetched.signalHash;
  }

  const metricsHash = metricsHashFor(features, signalHash);

  const cached = await readCache<PersonalizedExplanation>(
    actor,
    card.canonical_slug,
    profileVersion,
    metricsHash,
  );
  if (cached) return cached;

  const explanation = await buildPersonalizedExplanation(
    card,
    features,
    profile,
    capability,
    market,
  );
  await writeCache(actor, card.canonical_slug, profileVersion, metricsHash, explanation);
  return explanation;
}

/**
 * Get the structured Collector Insight for (actor, card) — the USER-centered
 * "should this card matter to this collector?" read. This is the primary
 * personalization surface; `getPersonalizedExplanation` is the legacy loose
 * shape retained for the existing web component.
 *
 * Honors the same per-(actor, card) cache (namespaced via a "ci:" metrics-hash
 * prefix so it can't collide with legacy explanation rows) and the capability
 * mode. On the LLM path the per-card market signal is fetched/backfilled and
 * passed as ENTRY-FIT context only — the prompt is told not to re-explain it.
 */
export async function getCollectorInsight(
  actor: Actor,
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
): Promise<CollectorInsight> {
  const capability = getPersonalizationCapability(actor);
  const profileVersion = profile?.version ?? PROFILE_VERSION;

  // Assemble the user-collection signal digest. Cheap, best-effort reads; any
  // failure degrades a signal to empty/unknown rather than throwing.
  const signals = await assembleCollectorSignals(actor, profile);

  // Pull (or backfill) the market signal only on the LLM path.
  let market: MarketSignalContext | null = null;
  let signalHash: string | null = null;
  if (capability.mode === "llm" && profile) {
    const fetched = await ensureMarketSignal(card.canonical_slug);
    market = fetched.context;
    signalHash = fetched.signalHash;
  }

  // Namespace + fold BOTH the data-richness band AND a digest of the
  // qualitative collector signals into the cache key, so a signal change that
  // doesn't cross the coarse `dataConfidence` band (e.g. saving different cards
  // or shifting favorite sets while staying "high") still invalidates a now-
  // stale read for the same user × card × market state.
  const metricsHash = `ci:${signals.dataConfidence}:${collectorSignalsDigest(signals)}:${metricsHashFor(features, signalHash)}`;

  const cached = await readCache<CollectorInsight>(
    actor,
    card.canonical_slug,
    profileVersion,
    metricsHash,
  );
  if (cached) return cached;

  const insight = await buildCollectorInsight(
    card,
    features,
    profile,
    signals,
    capability,
    market,
  );
  await writeCache(actor, card.canonical_slug, profileVersion, metricsHash, insight);
  return insight;
}
