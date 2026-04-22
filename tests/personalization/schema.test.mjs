import assert from "node:assert/strict";

import {
  parseBehaviorEvent,
  parseIngestPayload,
} from "@/lib/personalization/schema.ts";
import { MAX_EVENTS_PER_INGEST, MAX_PAYLOAD_BYTES } from "@/lib/personalization/constants.ts";

function buildEvent(overrides = {}) {
  return {
    event_type: "card_view",
    canonical_slug: "charizard-base-set-4",
    printing_id: null,
    variant_ref: null,
    occurred_at: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

export async function runSchemaTests() {
  // ── Accepts valid event ───────────────────────────────────────────────────
  {
    const parsed = parseBehaviorEvent(buildEvent());
    assert.ok(parsed);
    assert.equal(parsed.event_type, "card_view");
  }

  // ── Rejects unknown event type ────────────────────────────────────────────
  {
    const parsed = parseBehaviorEvent(buildEvent({ event_type: "not_an_event" }));
    assert.equal(parsed, null);
  }

  // ── Rejects bad occurred_at ───────────────────────────────────────────────
  {
    assert.equal(parseBehaviorEvent(buildEvent({ occurred_at: "not a date" })), null);
    assert.equal(parseBehaviorEvent(buildEvent({ occurred_at: null })), null);
    // Future too far out
    const tooFuture = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    assert.equal(parseBehaviorEvent(buildEvent({ occurred_at: tooFuture })), null);
    // Past too far back
    const tooOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(parseBehaviorEvent(buildEvent({ occurred_at: tooOld })), null);
  }

  // ── Rejects oversized payload ─────────────────────────────────────────────
  {
    const huge = "x".repeat(MAX_PAYLOAD_BYTES + 10);
    const parsed = parseBehaviorEvent(buildEvent({ payload: { blob: huge } }));
    assert.equal(parsed, null);
  }

  // ── Accepts null / missing canonical_slug ─────────────────────────────────
  {
    const parsed = parseBehaviorEvent(buildEvent({ canonical_slug: null }));
    assert.ok(parsed);
    assert.equal(parsed.canonical_slug, null);
  }

  // ── Normalizes empty string to null ───────────────────────────────────────
  {
    const parsed = parseBehaviorEvent(buildEvent({ canonical_slug: "" }));
    assert.ok(parsed);
    assert.equal(parsed.canonical_slug, null);
  }

  // ── parseIngestPayload: rejects empty or oversized batches ────────────────
  {
    assert.equal(parseIngestPayload({ events: [] }), null);
    assert.equal(
      parseIngestPayload({
        events: Array.from({ length: MAX_EVENTS_PER_INGEST + 1 }, () => buildEvent()),
      }),
      null,
    );
  }

  // ── parseIngestPayload: accepts valid batch, rejects single bad event ─────
  {
    const valid = parseIngestPayload({ events: [buildEvent(), buildEvent()] });
    assert.ok(valid);
    assert.equal(valid.events.length, 2);

    const mixed = parseIngestPayload({
      events: [buildEvent(), buildEvent({ event_type: "nope" })],
    });
    assert.equal(mixed, null, "a single bad event poisons the batch");
  }

  // ── parseIngestPayload: rejects non-object / missing events array ─────────
  {
    assert.equal(parseIngestPayload(null), null);
    assert.equal(parseIngestPayload({}), null);
    assert.equal(parseIngestPayload({ events: "nope" }), null);
    assert.equal(parseIngestPayload("not an object"), null);
  }

  console.log("  schema: ok");
}
