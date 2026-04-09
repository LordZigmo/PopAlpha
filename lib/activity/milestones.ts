import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActivityEvent } from "./emit";

/**
 * Value thresholds that trigger a milestone event. Only the highest
 * newly-crossed threshold fires (one event per threshold per day via dedupe).
 */
const VALUE_THRESHOLDS = [100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];

/**
 * Set completion percentages that trigger a milestone event.
 */
const SET_PROGRESS_THRESHOLDS = [25, 50, 75, 90, 100];

/**
 * Check and emit milestone events after a holdings change.
 * Fire-and-forget — never blocks the primary action.
 */
export async function checkAndEmitMilestones(opts: {
  actorId: string;
  db: SupabaseClient;
}): Promise<void> {
  try {
    await Promise.all([
      checkCollectionValue(opts),
      checkSetProgress(opts),
    ]);
  } catch (err) {
    console.error("[milestones] Failed to check milestones:", err);
  }
}

async function checkCollectionValue({ actorId, db }: { actorId: string; db: SupabaseClient }) {
  // Get all holdings with market prices
  const { data: holdings } = await db
    .from("holdings")
    .select("canonical_slug, qty")
    .eq("owner_clerk_id", actorId)
    .not("canonical_slug", "is", null);

  if (!holdings || holdings.length === 0) return;

  const slugs = [...new Set(holdings.map((h: { canonical_slug: string }) => h.canonical_slug))];

  const { data: metrics } = await db
    .from("public_card_metrics")
    .select("canonical_slug, market_price")
    .in("canonical_slug", slugs)
    .eq("grade", "RAW");

  if (!metrics) return;

  const priceMap = new Map<string, number>();
  for (const m of metrics as { canonical_slug: string; market_price: number | null }[]) {
    if (m.market_price != null) priceMap.set(m.canonical_slug, m.market_price);
  }

  let totalValue = 0;
  for (const h of holdings as { canonical_slug: string; qty: number }[]) {
    const price = priceMap.get(h.canonical_slug);
    if (price != null) totalValue += price * (h.qty ?? 0);
  }

  // Find highest crossed threshold
  const crossed = VALUE_THRESHOLDS.filter((t) => totalValue >= t);
  if (crossed.length === 0) return;

  const highestThreshold = crossed[crossed.length - 1];
  await emitActivityEvent({
    actorId,
    eventType: "milestone.collection_value",
    metadata: {
      value: Math.round(totalValue),
      threshold: highestThreshold,
    },
  });
}

async function checkSetProgress({ actorId, db }: { actorId: string; db: SupabaseClient }) {
  // Get all holdings with set info
  const { data: holdings } = await db
    .from("holdings")
    .select("canonical_slug")
    .eq("owner_clerk_id", actorId)
    .not("canonical_slug", "is", null);

  if (!holdings || holdings.length === 0) return;

  const slugs = [...new Set(holdings.map((h: { canonical_slug: string }) => h.canonical_slug))];

  const { data: cards } = await db
    .from("canonical_cards")
    .select("slug, set_name")
    .in("slug", slugs);

  if (!cards) return;

  // Group owned cards by set
  const heldSetMap = new Map<string, Set<string>>();
  for (const c of cards as { slug: string; set_name: string | null }[]) {
    const setName = c.set_name?.trim();
    if (!setName) continue;
    const bucket = heldSetMap.get(setName) ?? new Set<string>();
    bucket.add(c.slug);
    heldSetMap.set(setName, bucket);
  }

  if (heldSetMap.size === 0) return;

  // Find focus set (most owned cards)
  const [focusSetName, ownedSet] = [...heldSetMap.entries()].sort(
    (a, b) => b[1].size - a[1].size,
  )[0];

  // Get total cards in focus set
  const { count } = await db
    .from("canonical_cards")
    .select("slug", { count: "exact", head: true })
    .eq("set_name", focusSetName);

  const totalCount = count ?? 0;
  if (totalCount === 0) return;

  const percent = Math.round((ownedSet.size / totalCount) * 100);

  // Find highest crossed threshold
  const crossed = SET_PROGRESS_THRESHOLDS.filter((t) => percent >= t);
  if (crossed.length === 0) return;

  const highestThreshold = crossed[crossed.length - 1];
  await emitActivityEvent({
    actorId,
    eventType: "milestone.set_progress",
    metadata: {
      set_name: focusSetName,
      percent: highestThreshold,
      owned: ownedSet.size,
      total: totalCount,
    },
  });
}
