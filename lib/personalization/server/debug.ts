import "server-only";

import { dbAdmin } from "@/lib/db/admin";

import type { Actor } from "../types";

export type DebugEventRow = {
  id: number;
  event_type: string;
  canonical_slug: string | null;
  variant_ref: string | null;
  occurred_at: string;
  created_at: string;
};

/**
 * Load the last N behavior events for the actor — debug surface only.
 */
export async function loadRecentEventRows(
  actor: Actor,
  limit = 50,
): Promise<DebugEventRow[]> {
  try {
    const admin = dbAdmin();
    const { data, error } = await admin
      .from("personalization_behavior_events")
      .select("id, event_type, canonical_slug, variant_ref, occurred_at, created_at")
      .eq("actor_key", actor.actor_key)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[personalization:debug] loadRecentEventRows", error.message);
      return [];
    }
    return (data ?? []) as DebugEventRow[];
  } catch (err) {
    console.error("[personalization:debug] loadRecentEventRows unexpected", err);
    return [];
  }
}
