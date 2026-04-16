"use client";

import {
  ACTOR_COOKIE_NAME,
  buildActorCookieValue,
  isValidActorKey,
  mintGuestActorKey,
} from "../actor";
import { MAX_EVENTS_PER_INGEST } from "../constants";
import type { BehaviorEvent, EventType } from "../types";

type TrackInput = {
  type: EventType;
  canonical_slug?: string | null;
  printing_id?: string | null;
  variant_ref?: string | null;
  payload?: Record<string, unknown>;
};

type QueuedEvent = BehaviorEvent;

const FLUSH_DEBOUNCE_MS = 3_000;
const DEDUPE_WINDOW_MS = 1_500;
const MAX_BUFFER = MAX_EVENTS_PER_INGEST;
const ENDPOINT = "/api/personalization/events";

const buffer: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;
const recentDedupe = new Map<string, number>();

function readCookieActorKey(): string | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split(";");
  for (const raw of cookies) {
    const [name, ...rest] = raw.trim().split("=");
    if (name === ACTOR_COOKIE_NAME) {
      try {
        const value = decodeURIComponent(rest.join("="));
        if (isValidActorKey(value)) return value;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function writeCookieActorKey(key: string): void {
  if (typeof document === "undefined") return;
  document.cookie = buildActorCookieValue(key);
}

/** Ensure the page has an actor_key cookie; mint one on first call if absent. */
export function getOrMintActorKey(): string | null {
  if (typeof document === "undefined") return null;
  const existing = readCookieActorKey();
  if (existing) return existing;
  const fresh = mintGuestActorKey();
  writeCookieActorKey(fresh);
  return fresh;
}

function dedupeKey(event: QueuedEvent): string {
  return `${event.event_type}|${event.canonical_slug ?? ""}|${event.variant_ref ?? ""}`;
}

function shouldAcceptDedupe(event: QueuedEvent): boolean {
  const key = dedupeKey(event);
  const last = recentDedupe.get(key) ?? 0;
  const now = Date.now();
  if (now - last < DEDUPE_WINDOW_MS) return false;
  recentDedupe.set(key, now);
  // Simple cleanup: drop entries older than 60s to bound map growth.
  if (recentDedupe.size > 128) {
    for (const [k, t] of recentDedupe) {
      if (now - t > 60_000) recentDedupe.delete(k);
    }
  }
  return true;
}

function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, FLUSH_DEBOUNCE_MS);
}

async function flushNow(useBeacon = false): Promise<void> {
  if (buffer.length === 0) return;
  const events = buffer.splice(0, buffer.length);
  const payload = JSON.stringify({ events });
  try {
    if (
      useBeacon
      && typeof navigator !== "undefined"
      && typeof navigator.sendBeacon === "function"
    ) {
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon(ENDPOINT, blob);
      return;
    }
    await fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    });
  } catch {
    // Swallow — tracking is best-effort. Don't re-enqueue to avoid runaway
    // retries; the next user action will generate fresh events.
  }
}

function bindFlushListeners() {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushNow(true);
    }
  });
  window.addEventListener("pagehide", () => {
    void flushNow(true);
  });
}

/**
 * Emit a behavior event. Best-effort, debounced, deduped.
 * Safe to call from event handlers and effects.
 */
export function trackEvent(input: TrackInput): void {
  if (typeof window === "undefined") return;

  // Ensure cookie exists so the server can resolve the same actor_key.
  getOrMintActorKey();
  bindFlushListeners();

  const event: QueuedEvent = {
    event_type: input.type,
    canonical_slug: input.canonical_slug ?? null,
    printing_id: input.printing_id ?? null,
    variant_ref: input.variant_ref ?? null,
    payload: input.payload ?? {},
    occurred_at: new Date().toISOString(),
  };

  if (!shouldAcceptDedupe(event)) return;
  if (buffer.length >= MAX_BUFFER) return; // hard cap, drop overflow
  buffer.push(event);
  scheduleFlush();
}
