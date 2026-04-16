/**
 * Actor abstraction.
 *
 * Supports guest users immediately and is migration-safe for authenticated
 * Clerk users. All personalization data keys off `actor_key`, never directly
 * off Clerk.
 *
 * This module is import-safe in both client and server contexts — server-only
 * details live behind `getServerActor` which is NOT exported on the client
 * surface. Client helpers are in `./client-actor` below.
 */

import type { Actor, ActorKey } from "./types";

export const ACTOR_COOKIE_NAME = "pa_actor";
export const ACTOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1y

const GUEST_PREFIX = "guest:";
const USER_PREFIX = "user:";

// ── Key construction ────────────────────────────────────────────────────────

export function buildUserActorKey(clerkUserId: string): ActorKey {
  return `${USER_PREFIX}${clerkUserId}`;
}

export function buildGuestActorKey(raw: string): ActorKey {
  return `${GUEST_PREFIX}${raw}`;
}

export function isGuestActorKey(key: string): boolean {
  return key.startsWith(GUEST_PREFIX);
}

export function isUserActorKey(key: string): boolean {
  return key.startsWith(USER_PREFIX);
}

/** Strict validator — rejects garbage cookie values. */
export function isValidActorKey(key: string | null | undefined): key is ActorKey {
  if (!key || typeof key !== "string") return false;
  if (key.length < 10 || key.length > 200) return false;
  if (!isGuestActorKey(key) && !isUserActorKey(key)) return false;
  return true;
}

// ── UUID generator (runtime-agnostic) ────────────────────────────────────────

/**
 * Produces a UUIDv4 without pulling in a dependency. Safe in Edge, Node, and
 * browser contexts. Falls back to Math.random only if crypto is unavailable,
 * which should never happen in our deployment targets.
 */
export function generateGuestRandomPart(): string {
  try {
    // Browser + Node 19+ + Edge all expose globalThis.crypto.
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
    if (c && typeof c.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      // Per RFC 4122 §4.4 — set version (4) and variant bits.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
    }
  } catch {
    /* fallthrough */
  }
  // Very weak fallback — only reached in environments without crypto.
  const rand = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  return `${rand()}${rand()}-${rand().slice(0, 4)}-4${rand().slice(0, 3)}-${rand().slice(0, 4)}-${rand()}${rand().slice(0, 4)}`;
}

export function mintGuestActorKey(): ActorKey {
  return buildGuestActorKey(generateGuestRandomPart());
}

// ── Cookie string builder (works in both client and server contexts) ─────────

export function buildActorCookieValue(key: ActorKey): string {
  const attrs = [
    `${ACTOR_COOKIE_NAME}=${encodeURIComponent(key)}`,
    `Path=/`,
    `Max-Age=${ACTOR_COOKIE_MAX_AGE_SECONDS}`,
    `SameSite=Lax`,
  ];
  if (typeof window === "undefined" || window.location?.protocol === "https:") {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

// ── Typed helpers re-exported for consumers ──────────────────────────────────

export type { Actor, ActorKey };
