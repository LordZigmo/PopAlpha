import "server-only";

import { dbAdmin } from "@/lib/db/admin";

import { PROFILE_VERSION } from "../constants";
import type {
  Actor,
  BehaviorEvent,
  CardStyleFeatures,
  StyleProfile,
} from "../types";
import {
  getCardStyleFeatures,
  type CardFeatureInput,
  type CardMetricsInput,
} from "../features/card-features";
import { scoreProfile, type CardFeatureResolver } from "../scoring/score";
import { buildProfileSummary } from "../summary/build-summary";

/**
 * Recency cap for recompute — we only score the most recent N events per actor
 * to keep recompute time bounded. 500 is generous for V1.
 */
const MAX_EVENTS_FOR_RECOMPUTE = 500;

type RawEventRow = {
  event_type: string;
  canonical_slug: string | null;
  printing_id: string | null;
  variant_ref: string | null;
  occurred_at: string;
  payload: Record<string, unknown> | null;
};

type CanonicalRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
};

type MetricsRow = {
  canonical_slug: string;
  liquidity_score: number | null;
  volatility_30d: number | null;
  active_listings_7d: number | null;
};

type PrintingRow = {
  id: string;
  canonical_slug: string;
  rarity: string | null;
  finish: string | null;
};

function coerceRow(row: RawEventRow): BehaviorEvent {
  return {
    event_type: row.event_type as BehaviorEvent["event_type"],
    canonical_slug: row.canonical_slug,
    printing_id: row.printing_id,
    variant_ref: row.variant_ref,
    occurred_at: row.occurred_at,
    payload: row.payload ?? {},
  };
}

function isGradedFromVariantRef(ref: string | null): boolean {
  if (!ref) return false;
  return /(::PSA|::CGC|::BGS|::TAG)/i.test(ref);
}

/**
 * Load behavior events for the given actor + any claimed guest keys.
 * Returns the most recent N rows.
 */
async function loadRecentEvents(actor: Actor): Promise<BehaviorEvent[]> {
  const keys = [actor.actor_key, ...(actor.claimed_guest_keys ?? [])];
  if (keys.length === 0) return [];
  const admin = dbAdmin();
  const { data, error } = await admin
    .from("personalization_behavior_events")
    .select("event_type, canonical_slug, printing_id, variant_ref, occurred_at, payload")
    .in("actor_key", keys)
    .order("occurred_at", { ascending: false })
    .limit(MAX_EVENTS_FOR_RECOMPUTE);
  if (error) {
    console.error("[personalization:recompute] loadRecentEvents", error.message);
    return [];
  }
  return (data ?? []).map((row) => coerceRow(row as RawEventRow));
}

/**
 * Build a resolver function over the unique canonical_slugs present in the
 * event stream. Only a few slugs are typically needed per recompute so we can
 * simply batch-load and cache.
 */
async function buildFeatureResolver(events: BehaviorEvent[]): Promise<CardFeatureResolver> {
  const slugs = Array.from(
    new Set(events.map((e) => e.canonical_slug).filter((s): s is string => !!s)),
  );
  if (slugs.length === 0) {
    return () => null;
  }

  const admin = dbAdmin();

  const [canonicalRes, metricsRes, printingRes] = await Promise.all([
    admin
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year, card_number")
      .in("slug", slugs),
    admin
      .from("public_card_metrics")
      .select("canonical_slug, liquidity_score, volatility_30d, active_listings_7d")
      .in("canonical_slug", slugs)
      .is("printing_id", null)
      .is("grade", null),
    admin
      .from("card_printings")
      .select("id, canonical_slug, rarity, finish")
      .in("canonical_slug", slugs),
  ]);

  const canonicalBySlug = new Map<string, CanonicalRow>();
  for (const row of (canonicalRes.data ?? []) as CanonicalRow[]) {
    canonicalBySlug.set(row.slug, row);
  }
  const metricsBySlug = new Map<string, MetricsRow>();
  for (const row of (metricsRes.data ?? []) as MetricsRow[]) {
    metricsBySlug.set(row.canonical_slug, row);
  }
  const printingsBySlug = new Map<string, PrintingRow[]>();
  for (const row of (printingRes.data ?? []) as PrintingRow[]) {
    const arr = printingsBySlug.get(row.canonical_slug) ?? [];
    arr.push(row);
    printingsBySlug.set(row.canonical_slug, arr);
  }

  const cache = new Map<string, CardStyleFeatures>();

  return (slug, variantRef) => {
    if (!slug) return null;
    const cacheKey = `${slug}::${variantRef ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const canonical = canonicalBySlug.get(slug);
    if (!canonical) return null;
    const metrics = metricsBySlug.get(slug);
    const printings = printingsBySlug.get(slug) ?? [];
    // Pick a printing to represent rarity/finish — prefer one with a rarity set.
    const printing =
      printings.find((p) => p.rarity)
      ?? printings[0]
      ?? null;

    const cardInput: CardFeatureInput = {
      canonical_slug: slug,
      set_name: canonical.set_name ?? null,
      release_year: canonical.year ?? null,
      rarity: printing?.rarity ?? null,
      card_number: canonical.card_number ?? null,
      finish: printing?.finish ?? null,
      is_graded: isGradedFromVariantRef(variantRef ?? null),
    };
    const metricsInput: CardMetricsInput = {
      active_listings_7d: metrics?.active_listings_7d ?? null,
      liquidity_score: metrics?.liquidity_score ?? null,
      volatility_30d: metrics?.volatility_30d ?? null,
    };
    const features = getCardStyleFeatures(cardInput, metricsInput);
    cache.set(cacheKey, features);
    return features;
  };
}

/**
 * Compute and persist an up-to-date style profile for the given actor.
 * Idempotent — safe to call on every ingest tick or from the debug surface.
 */
export async function recomputeProfile(actor: Actor): Promise<StyleProfile | null> {
  const events = await loadRecentEvents(actor);
  const resolver = await buildFeatureResolver(events);
  const scores = scoreProfile(events, resolver, new Date());
  const summary = buildProfileSummary(scores, events.length);

  const profile: StyleProfile = {
    actor_key: actor.actor_key,
    dominant_style_label: summary.dominant_style_label,
    supporting_traits: summary.supporting_traits,
    summary: summary.summary,
    confidence: summary.confidence,
    evidence: summary.evidence,
    scores,
    event_count: events.length,
    version: PROFILE_VERSION,
    updated_at: new Date().toISOString(),
  };

  try {
    const admin = dbAdmin();
    const { error } = await admin
      .from("personalization_profiles")
      .upsert(
        {
          actor_key: profile.actor_key,
          clerk_user_id: actor.clerk_user_id,
          dominant_style_label: profile.dominant_style_label,
          supporting_traits: profile.supporting_traits,
          summary: profile.summary,
          confidence: profile.confidence,
          evidence: profile.evidence,
          scores: profile.scores,
          version: profile.version,
          event_count: profile.event_count,
          updated_at: profile.updated_at,
        },
        { onConflict: "actor_key" },
      );
    if (error) {
      console.error("[personalization:recompute] upsert", error.message);
    }
  } catch (err) {
    console.error("[personalization:recompute] unexpected", err);
  }

  return profile;
}

/**
 * Load the stored profile for an actor, returning null when absent.
 * Used by the explanation route.
 */
export async function loadProfile(actor: Actor): Promise<StyleProfile | null> {
  try {
    const admin = dbAdmin();
    const { data, error } = await admin
      .from("personalization_profiles")
      .select("actor_key, dominant_style_label, supporting_traits, summary, confidence, evidence, scores, version, event_count, updated_at")
      .eq("actor_key", actor.actor_key)
      .maybeSingle();
    if (error) {
      console.error("[personalization:loadProfile]", error.message);
      return null;
    }
    if (!data) return null;
    return {
      actor_key: data.actor_key as string,
      dominant_style_label: (data.dominant_style_label as string) ?? "emerging collector",
      supporting_traits: (data.supporting_traits as string[]) ?? [],
      summary: (data.summary as string) ?? "",
      confidence: Number(data.confidence ?? 0),
      evidence: (data.evidence as StyleProfile["evidence"]) ?? [],
      scores: (data.scores as StyleProfile["scores"]) ?? ({} as StyleProfile["scores"]),
      version: Number(data.version ?? PROFILE_VERSION),
      event_count: Number(data.event_count ?? 0),
      updated_at: (data.updated_at as string) ?? new Date().toISOString(),
    };
  } catch (err) {
    console.error("[personalization:loadProfile] unexpected", err);
    return null;
  }
}

/**
 * Delete all events + profile for an actor. Debug-only helper.
 */
export async function clearActorData(actor: Actor): Promise<void> {
  try {
    const admin = dbAdmin();
    await admin
      .from("personalization_behavior_events")
      .delete()
      .eq("actor_key", actor.actor_key);
    await admin
      .from("personalization_profiles")
      .delete()
      .eq("actor_key", actor.actor_key);
    await admin
      .from("personalization_explanation_cache")
      .delete()
      .eq("actor_key", actor.actor_key);
  } catch (err) {
    console.error("[personalization:clearActorData]", err);
  }
}
