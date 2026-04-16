import {
  EVENT_TYPES,
  MAX_EVENTS_PER_INGEST,
  MAX_PAYLOAD_BYTES,
} from "./constants";
import type { BehaviorEvent, EventType } from "./types";

// ── Primitives ───────────────────────────────────────────────────────────────

function isOptionalString(value: unknown, max = 256): value is string | null {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.length <= max;
}

function isIsoString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  // Reject extreme future (> 1h ahead) or extreme past (< 7d behind) to limit replay abuse.
  const now = Date.now();
  const t = d.getTime();
  return t <= now + 60 * 60 * 1000 && t >= now - 7 * 24 * 60 * 60 * 1000;
}

function isEventType(value: unknown): value is EventType {
  if (typeof value !== "string") return false;
  return (EVENT_TYPES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approxByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ── Event parsing ────────────────────────────────────────────────────────────

/**
 * Parse a single candidate behavior event.
 * Returns the normalized shape or null when invalid.
 */
export function parseBehaviorEvent(raw: unknown): BehaviorEvent | null {
  if (!isPlainObject(raw)) return null;

  if (!isEventType(raw.event_type)) return null;
  if (!isIsoString(raw.occurred_at)) return null;

  if (!isOptionalString(raw.canonical_slug, 200)) return null;
  if (!isOptionalString(raw.printing_id, 64)) return null;
  if (!isOptionalString(raw.variant_ref, 128)) return null;

  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(payload)) return null;
  if (approxByteSize(payload) > MAX_PAYLOAD_BYTES) return null;

  return {
    event_type: raw.event_type,
    canonical_slug:
      typeof raw.canonical_slug === "string" && raw.canonical_slug.length > 0
        ? raw.canonical_slug
        : null,
    printing_id:
      typeof raw.printing_id === "string" && raw.printing_id.length > 0
        ? raw.printing_id
        : null,
    variant_ref:
      typeof raw.variant_ref === "string" && raw.variant_ref.length > 0
        ? raw.variant_ref
        : null,
    occurred_at: raw.occurred_at,
    payload,
  };
}

// ── Ingest payload parsing ───────────────────────────────────────────────────

export type ParsedIngestPayload = {
  events: BehaviorEvent[];
};

/**
 * Parse an `/api/personalization/events` POST body.
 * Returns null when the payload is malformed.
 */
export function parseIngestPayload(raw: unknown): ParsedIngestPayload | null {
  if (!isPlainObject(raw)) return null;
  const rawEvents = raw.events;
  if (!Array.isArray(rawEvents)) return null;
  if (rawEvents.length === 0 || rawEvents.length > MAX_EVENTS_PER_INGEST) return null;

  const events: BehaviorEvent[] = [];
  for (const candidate of rawEvents) {
    const parsed = parseBehaviorEvent(candidate);
    if (!parsed) return null;
    events.push(parsed);
  }

  return { events };
}

// Re-export for convenience from tests / callers.
export { isIsoString, isEventType };
