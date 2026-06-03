import "server-only";

import { dbAdmin } from "@/lib/db/admin";

import { MIN_EVENTS_FOR_CONFIDENT_PROFILE, MIN_EVENTS_FOR_EARLY_SIGNAL } from "../constants";
import type { Actor, CollectorSignals, StyleProfile } from "../types";

/**
 * Assemble the USER-collection signal digest fed to the Collector Insight
 * prompt and the deterministic builder.
 *
 * Sources:
 *  - personalization_behavior_events — saved (collection_add), watchlist
 *    (watchlist_add), repeatedly-viewed (card_view counts), graded/raw
 *    (variant_switch refs), favorite sets (per-set frequency).
 *  - scan_identify_events — scanned cards.
 *  - canonical_cards — slug → display name, set, language (for JP/EN).
 *
 * Best-effort: any query failure degrades the corresponding signal to
 * empty/unknown rather than throwing. We never invent a signal — thin data
 * yields `dataConfidence: "low" | "none"`, which the prompt and builder use to
 * pick soft framing.
 */

const MAX_EVENTS = 500;
const MAX_SCAN_EVENTS = 50;

type EventRow = {
  event_type: string;
  canonical_slug: string | null;
  variant_ref: string | null;
};

type CanonicalRow = {
  slug: string;
  canonical_name: string | null;
  set_name: string | null;
  language: string | null;
};

function isGradedRef(ref: string | null): boolean {
  return !!ref && /(::PSA|::CGC|::BGS|::TAG)/i.test(ref);
}

function isRawRef(ref: string | null): boolean {
  return !!ref && /::RAW/i.test(ref);
}

function deriveGradedVsRaw(
  events: EventRow[],
): CollectorSignals["gradedVsRawInterest"] {
  let graded = 0;
  let raw = 0;
  for (const e of events) {
    if (e.event_type !== "variant_switch") continue;
    if (isGradedRef(e.variant_ref)) graded += 1;
    else if (isRawRef(e.variant_ref)) raw += 1;
  }
  if (graded === 0 && raw === 0) return "unknown";
  if (graded > 0 && raw > 0) return "mixed";
  return graded > 0 ? "graded" : "raw";
}

function deriveLanguage(
  engagedSlugs: Set<string>,
  canonicalBySlug: Map<string, CanonicalRow>,
): CollectorSignals["languagePreference"] {
  let jp = 0;
  let en = 0;
  for (const slug of engagedSlugs) {
    const lang = (canonicalBySlug.get(slug)?.language ?? "").toUpperCase();
    if (lang === "JP") jp += 1;
    else if (lang === "EN") en += 1;
  }
  if (jp === 0 && en === 0) return "unknown";
  if (jp > 0 && en > 0) {
    // Call it mixed only when neither clearly dominates.
    const total = jp + en;
    if (jp / total >= 0.8) return "jp";
    if (en / total >= 0.8) return "en";
    return "mixed";
  }
  return jp > 0 ? "jp" : "en";
}

function nameFor(slug: string, canonicalBySlug: Map<string, CanonicalRow>): string {
  return canonicalBySlug.get(slug)?.canonical_name?.trim() || slug;
}

function rankByFrequency(counts: Map<string, number>, min = 1): string[] {
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

function pickDataConfidence(params: {
  eventCount: number;
  profileConfidence: number;
  savedCount: number;
  watchlistCount: number;
  scannedCount: number;
}): CollectorSignals["dataConfidence"] {
  const { eventCount, profileConfidence, savedCount, watchlistCount, scannedCount } = params;
  const intentSignals = savedCount + watchlistCount + scannedCount;
  if (eventCount < MIN_EVENTS_FOR_EARLY_SIGNAL && intentSignals === 0) return "none";
  if (
    eventCount >= MIN_EVENTS_FOR_CONFIDENT_PROFILE
    && profileConfidence >= 0.5
    && intentSignals >= 2
  ) {
    return "high";
  }
  if (eventCount >= MIN_EVENTS_FOR_EARLY_SIGNAL && (profileConfidence >= 0.3 || intentSignals >= 1)) {
    return "medium";
  }
  return "low";
}

async function loadBehaviorEvents(actor: Actor): Promise<EventRow[]> {
  const keys = [actor.actor_key, ...(actor.claimed_guest_keys ?? [])];
  if (keys.length === 0) return [];
  try {
    const admin = dbAdmin();
    const { data, error } = await admin
      .from("personalization_behavior_events")
      .select("event_type, canonical_slug, variant_ref")
      .in("actor_key", keys)
      .order("occurred_at", { ascending: false })
      .limit(MAX_EVENTS);
    if (error) {
      console.error("[personalization:collector-signals] events", error.message);
      return [];
    }
    return (data ?? []) as EventRow[];
  } catch (err) {
    console.error("[personalization:collector-signals] events unexpected", err);
    return [];
  }
}

async function loadScannedSlugs(actor: Actor): Promise<string[]> {
  const keys = [actor.actor_key, ...(actor.claimed_guest_keys ?? [])];
  if (keys.length === 0) return [];
  try {
    const admin = dbAdmin();
    const { data, error } = await admin
      .from("scan_identify_events")
      .select("top_match_slug")
      .in("actor_key", keys)
      .not("top_match_slug", "is", null)
      .order("created_at", { ascending: false })
      .limit(MAX_SCAN_EVENTS);
    if (error) {
      // Non-fatal: scans simply won't inform the read.
      console.warn("[personalization:collector-signals] scans", error.message);
      return [];
    }
    const slugs: string[] = [];
    for (const row of (data ?? []) as Array<{ top_match_slug: string | null }>) {
      if (row.top_match_slug) slugs.push(row.top_match_slug);
    }
    return slugs;
  } catch (err) {
    console.warn("[personalization:collector-signals] scans unexpected", err);
    return [];
  }
}

async function resolveCanonical(
  slugs: Set<string>,
): Promise<Map<string, CanonicalRow>> {
  const out = new Map<string, CanonicalRow>();
  if (slugs.size === 0) return out;
  try {
    const admin = dbAdmin();
    const { data, error } = await admin
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, language")
      .in("slug", [...slugs]);
    if (error) {
      console.warn("[personalization:collector-signals] canonical", error.message);
      return out;
    }
    for (const row of (data ?? []) as CanonicalRow[]) {
      out.set(row.slug, row);
    }
    return out;
  } catch (err) {
    console.warn("[personalization:collector-signals] canonical unexpected", err);
    return out;
  }
}

export async function assembleCollectorSignals(
  actor: Actor,
  profile: StyleProfile | null,
): Promise<CollectorSignals> {
  const [events, scannedSlugs] = await Promise.all([
    loadBehaviorEvents(actor),
    loadScannedSlugs(actor),
  ]);

  // Bucket slugs by intent.
  const savedSlugs: string[] = [];
  const watchlistSlugs: string[] = [];
  const viewCounts = new Map<string, number>();
  const setCounts = new Map<string, number>();
  const engagedSlugs = new Set<string>(scannedSlugs);

  for (const e of events) {
    const slug = e.canonical_slug;
    if (slug) engagedSlugs.add(slug);
    if (e.event_type === "collection_add" && slug) savedSlugs.push(slug);
    else if (e.event_type === "watchlist_add" && slug) watchlistSlugs.push(slug);
    else if (e.event_type === "card_view" && slug) {
      viewCounts.set(slug, (viewCounts.get(slug) ?? 0) + 1);
    }
  }

  const canonicalBySlug = await resolveCanonical(engagedSlugs);

  // Favorite sets — tally set_name across all engaged slugs (weighted by views
  // where we have them, else a single count per engaged slug).
  for (const slug of engagedSlugs) {
    const setName = canonicalBySlug.get(slug)?.set_name?.trim();
    if (!setName) continue;
    const weight = Math.max(1, viewCounts.get(slug) ?? 1);
    setCounts.set(setName, (setCounts.get(setName) ?? 0) + weight);
  }

  const dedupe = (slugs: string[]): string[] => [...new Set(slugs)];

  const savedNames = dedupe(savedSlugs).map((s) => nameFor(s, canonicalBySlug));
  const watchlistNames = dedupe(watchlistSlugs).map((s) => nameFor(s, canonicalBySlug));
  const scannedNames = dedupe(scannedSlugs).map((s) => nameFor(s, canonicalBySlug));
  const repeatedlyViewedNames = rankByFrequency(viewCounts, 2).map((s) => nameFor(s, canonicalBySlug));
  const favoriteSets = rankByFrequency(setCounts, 2).slice(0, 5);

  const collectorType = profile?.dominant_style_label?.trim() || "emerging collector";
  const supportingTraits = profile?.supporting_traits ?? [];
  const profileConfidence = profile?.confidence ?? 0;
  const eventCount = profile?.event_count ?? events.length;

  const dataConfidence = pickDataConfidence({
    eventCount,
    profileConfidence,
    savedCount: savedNames.length,
    watchlistCount: watchlistNames.length,
    scannedCount: scannedNames.length,
  });

  return {
    collectorType,
    supportingTraits,
    profileConfidence,
    eventCount,
    savedCardNames: savedNames,
    watchlistCardNames: watchlistNames,
    scannedCardNames: scannedNames,
    repeatedlyViewedCardNames: repeatedlyViewedNames,
    favoriteSets,
    gradedVsRawInterest: deriveGradedVsRaw(events),
    languagePreference: deriveLanguage(engagedSlugs, canonicalBySlug),
    dataConfidence,
  };
}
