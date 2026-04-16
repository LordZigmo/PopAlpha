import "server-only";

import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

import { dbAdmin } from "@/lib/db/admin";

import {
  ACTOR_COOKIE_MAX_AGE_SECONDS,
  ACTOR_COOKIE_NAME,
  buildUserActorKey,
  isValidActorKey,
  mintGuestActorKey,
} from "../actor";
import type { Actor, ActorKey } from "../types";

/** Header used by native clients (iOS, Android) that do not send cookies. */
export const ACTOR_HEADER_NAME = "x-pa-actor-key";

/**
 * Resolve the current request's actor.
 *
 * Priority:
 *   1. Clerk session → user actor
 *   2. `pa_actor` cookie → guest actor (web)
 *   3. `X-PA-Actor-Key` header → guest actor (native clients)
 *   4. Mint a new guest actor (cookie still needs to be written by the caller)
 *
 * The server MUST NOT write cookies during React Server Component render —
 * callers in Route Handlers use {@link setActorCookieOnResponse} to persist
 * the minted key on the response. Native clients read the returned actor_key
 * from the response body and persist it themselves.
 */
export async function resolveActor(req?: Request): Promise<Actor> {
  const { userId } = await auth();
  const cookieStore = await cookies();
  const existingCookie = cookieStore.get(ACTOR_COOKIE_NAME)?.value ?? null;
  const cookieKey = isValidActorKey(existingCookie) ? existingCookie : null;
  const headerRaw = req?.headers.get(ACTOR_HEADER_NAME) ?? null;
  const headerKey = isValidActorKey(headerRaw) ? headerRaw : null;

  if (userId) {
    const actor_key = buildUserActorKey(userId);
    const claims = await loadClaimedGuestKeys(userId);
    return {
      actor_key,
      clerk_user_id: userId,
      needs_cookie_set: cookieKey !== actor_key,
      claimed_guest_keys: claims,
    };
  }

  if (cookieKey) {
    return {
      actor_key: cookieKey,
      clerk_user_id: null,
      needs_cookie_set: false,
      claimed_guest_keys: [],
    };
  }

  if (headerKey) {
    // Native client supplied its own stable key — trust it. Do not set a
    // cookie; the client persists the key locally.
    return {
      actor_key: headerKey,
      clerk_user_id: null,
      needs_cookie_set: false,
      claimed_guest_keys: [],
    };
  }

  return {
    actor_key: mintGuestActorKey(),
    clerk_user_id: null,
    needs_cookie_set: true,
    claimed_guest_keys: [],
  };
}

/**
 * Load the guest keys that a Clerk user has claimed historically.
 * Used by recompute to UNION signal across the user's pre-signup guest sessions.
 */
export async function loadClaimedGuestKeys(clerkUserId: string): Promise<string[]> {
  try {
    const admin = dbAdmin();
    const { data, error } = await admin
      .from("personalization_actor_claims")
      .select("guest_key")
      .eq("clerk_user_id", clerkUserId);
    if (error) {
      console.error("[personalization:actor] loadClaimedGuestKeys", error.message);
      return [];
    }
    return (data ?? []).map((row) => row.guest_key as string);
  } catch (err) {
    console.error("[personalization:actor] loadClaimedGuestKeys", err);
    return [];
  }
}

export function setActorCookieOnResponse(response: NextResponse, actorKey: ActorKey) {
  response.cookies.set({
    name: ACTOR_COOKIE_NAME,
    value: actorKey,
    path: "/",
    maxAge: ACTOR_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
  });
}

/**
 * Claim a guest actor for an authenticated user.
 * Idempotent — safe to call on every sign-in.
 */
export async function claimGuestActor(
  clerkUserId: string,
  guestKey: ActorKey,
): Promise<void> {
  if (!isValidActorKey(guestKey)) return;
  if (!guestKey.startsWith("guest:")) return;
  try {
    const admin = dbAdmin();
    await admin
      .from("personalization_actor_claims")
      .upsert(
        { guest_key: guestKey, clerk_user_id: clerkUserId },
        { onConflict: "guest_key", ignoreDuplicates: true },
      );
  } catch (err) {
    console.error("[personalization:actor] claimGuestActor", err);
  }
}
