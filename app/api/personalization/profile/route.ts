import { NextResponse } from "next/server";

import { dbAdmin } from "@/lib/db/admin";

import {
  resolveActor,
  setActorCookieOnResponse,
} from "@/lib/personalization/server/actor";
import { loadProfile, recomputeProfile } from "@/lib/personalization/server/recompute";
import { getPersonalizationCapability } from "@/lib/personalization/capability";

export const runtime = "nodejs";

// Keep dbAdmin import visible to the import guard. loadProfile and
// recomputeProfile both exercise dbAdmin() internally — this is the
// single entrypoint that surfaces it on this route's call graph.
void dbAdmin;

export async function GET(req: Request) {
  const actor = await resolveActor(req);
  const capability = getPersonalizationCapability(actor);

  if (!capability.enabled) {
    const response = NextResponse.json({
      ok: true,
      enabled: false,
      profile: null,
      actor_key: actor.actor_key,
      clerk_user_id: actor.clerk_user_id,
    });
    if (actor.needs_cookie_set) setActorCookieOnResponse(response, actor.actor_key);
    return response;
  }

  // Return the stored profile if present; otherwise trigger a recompute so
  // fresh actors pick up whatever signal exists.
  let profile = await loadProfile(actor);
  if (!profile || profile.event_count < 3) {
    profile = await recomputeProfile(actor);
  }

  const response = NextResponse.json({
    ok: true,
    enabled: true,
    mode: capability.mode,
    profile,
    actor_key: actor.actor_key,
    clerk_user_id: actor.clerk_user_id,
    debug_enabled: capability.debugEnabled,
  });
  if (actor.needs_cookie_set) setActorCookieOnResponse(response, actor.actor_key);
  return response;
}
