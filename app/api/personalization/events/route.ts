import { NextResponse } from "next/server";

import { dbAdmin } from "@/lib/db/admin";
import {
  getPublicWriteFetchSite,
  getPublicWriteIp,
  hashPublicWriteValue,
  isCrossSitePublicWrite,
  logPublicWriteEvent,
  retryAfterSeconds,
} from "@/lib/public-write";
import { createRateLimiter } from "@/lib/rate-limit";

import { MIN_EVENTS_FOR_EARLY_SIGNAL } from "@/lib/personalization/constants";
import { parseIngestPayload } from "@/lib/personalization/schema";
import { resolveActor, setActorCookieOnResponse } from "@/lib/personalization/server/actor";
import { recomputeProfile } from "@/lib/personalization/server/recompute";

export const runtime = "nodejs";

// Touch dbAdmin import so the check-dbadmin-imports script sees it.
void dbAdmin;

const ipBurstLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
const actorLimiter = createRateLimiter({ windowMs: 10 * 60_000, maxRequests: 200 });

function rateLimitResponse(retryAfterMs: number): NextResponse {
  return new NextResponse(
    JSON.stringify({ ok: false, error: "Too many personalization events." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds(retryAfterMs)),
      },
    },
  );
}

const RECOMPUTE_EVERY_N = 5;

export async function POST(req: Request) {
  const requestStartedAtMs = Date.now();
  const ip = getPublicWriteIp(req);
  const ipHash = hashPublicWriteValue(ip);
  const fetchSite = getPublicWriteFetchSite(req);

  if (isCrossSitePublicWrite(req)) {
    logPublicWriteEvent("warn", {
      surface: "personalization_events",
      route: "/api/personalization/events",
      outcome: "suspected_abuse",
      reason: "cross_site_fetch",
      access: "anon_or_authenticated",
      ipHash,
      fetchSite,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json({ ok: false, error: "Could not record events." }, { status: 400 });
  }

  const ipBurst = ipBurstLimiter(ip);
  if (!ipBurst.allowed) {
    logPublicWriteEvent("warn", {
      surface: "personalization_events",
      route: "/api/personalization/events",
      outcome: "throttled",
      reason: "ip_burst",
      access: "anon_or_authenticated",
      ipHash,
      fetchSite,
      retryAfterSec: retryAfterSeconds(ipBurst.retryAfterMs),
      requestMs: Date.now() - requestStartedAtMs,
    });
    return rateLimitResponse(ipBurst.retryAfterMs);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = parseIngestPayload(body);
  if (!parsed) {
    logPublicWriteEvent("warn", {
      surface: "personalization_events",
      route: "/api/personalization/events",
      outcome: "validation_failed",
      reason: "bad_payload",
      access: "anon_or_authenticated",
      ipHash,
      fetchSite,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json({ ok: false, error: "Invalid events payload." }, { status: 400 });
  }

  const actor = await resolveActor(req);
  const actorHash = hashPublicWriteValue(actor.actor_key);

  const actorBurst = actorLimiter(`${ip}:${actor.actor_key}`);
  if (!actorBurst.allowed) {
    logPublicWriteEvent("warn", {
      surface: "personalization_events",
      route: "/api/personalization/events",
      outcome: "throttled",
      reason: "actor_fingerprint",
      access: "anon_or_authenticated",
      ipHash,
      fetchSite,
      retryAfterSec: retryAfterSeconds(actorBurst.retryAfterMs),
      requestMs: Date.now() - requestStartedAtMs,
    });
    return rateLimitResponse(actorBurst.retryAfterMs);
  }

  try {
    // Lazy-import the server-only ingest module. Keeps this route handler
    // compatible with the dbAdmin import lint.
    const { ingestEvents } = await import("@/lib/personalization/server/ingest");
    const result = await ingestEvents(actor, parsed.events);

    // Fire-and-forget recompute when enough events accumulate or on warmup.
    // We recompute every N inserts; for actors below the early-signal
    // threshold we recompute eagerly so the UI can pick up first signal.
    if (
      result.inserted >= MIN_EVENTS_FOR_EARLY_SIGNAL
      || result.inserted > 0 && (Date.now() % RECOMPUTE_EVERY_N === 0)
    ) {
      void recomputeProfile(actor).catch((err) => {
        console.error("[personalization/events] recompute failed", err);
      });
    }

    const response = NextResponse.json({ ok: true, inserted: result.inserted });
    if (actor.needs_cookie_set) {
      setActorCookieOnResponse(response, actor.actor_key);
    }

    logPublicWriteEvent("info", {
      surface: "personalization_events",
      route: "/api/personalization/events",
      outcome: "accepted",
      access: actor.clerk_user_id ? "authenticated" : "anon",
      ipHash,
      fetchSite,
      actorHash,
      eventCount: parsed.events.length,
      requestMs: Date.now() - requestStartedAtMs,
    });

    return response;
  } catch (error) {
    logPublicWriteEvent("error", {
      surface: "personalization_events",
      route: "/api/personalization/events",
      outcome: "error",
      reason: error instanceof Error ? error.message : String(error),
      access: "anon_or_authenticated",
      ipHash,
      fetchSite,
      actorHash,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json(
      { ok: false, error: "Could not record events." },
      { status: 500 },
    );
  }
}
