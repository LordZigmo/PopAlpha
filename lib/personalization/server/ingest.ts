import "server-only";

import { dbAdmin } from "@/lib/db/admin";

import type { Actor, BehaviorEvent } from "../types";

export type IngestResult = {
  inserted: number;
};

/**
 * Persist a batch of behavior events for an actor.
 * Fire-and-forget — callers do not await this on the request critical path.
 *
 * Server-only. Never exposed to the client.
 */
export async function ingestEvents(
  actor: Actor,
  events: BehaviorEvent[],
): Promise<IngestResult> {
  if (events.length === 0) return { inserted: 0 };

  const rows = events.map((e) => ({
    actor_key: actor.actor_key,
    clerk_user_id: actor.clerk_user_id,
    event_type: e.event_type,
    canonical_slug: e.canonical_slug,
    printing_id: e.printing_id,
    variant_ref: e.variant_ref,
    payload: e.payload ?? {},
    occurred_at: e.occurred_at,
  }));

  try {
    const admin = dbAdmin();
    const { error, data } = await admin
      .from("personalization_behavior_events")
      .insert(rows)
      .select("id");
    if (error) {
      console.error("[personalization:ingest]", error.message);
      return { inserted: 0 };
    }
    return { inserted: data?.length ?? 0 };
  } catch (err) {
    console.error("[personalization:ingest] unexpected", err);
    return { inserted: 0 };
  }
}
