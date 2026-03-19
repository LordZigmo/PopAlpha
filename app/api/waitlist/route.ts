import { NextResponse } from "next/server";
import { resolveAuthContext } from "@/lib/auth/context";
import {
  inspectWaitlistBotSignals,
  isValidWaitlistEmail,
  isValidWaitlistTier,
  normalizeWaitlistEmail,
  submitWaitlistSignup,
  WAITLIST_SIGNUP_SOURCE,
} from "@/lib/data/waitlist";
import { dbPublic } from "@/lib/db";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import {
  getPublicWriteIp,
  hashPublicWriteValue,
  logPublicWriteEvent,
  retryAfterSeconds,
} from "@/lib/public-write";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const ipBurstLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 8 });
const submissionLimiter = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 4 });

type WaitlistRequestBody = {
  email?: unknown;
  tier?: unknown;
  website?: unknown;
  formStartedAtMs?: unknown;
};

function rateLimitResponse(retryAfterMs: number) {
  return new NextResponse(
    JSON.stringify({ ok: false, error: "Too many waitlist attempts. Please try again shortly." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds(retryAfterMs)),
      },
    },
  );
}

export async function POST(req: Request) {
  const requestStartedAtMs = Date.now();
  const ip = getPublicWriteIp(req);
  const ipHash = hashPublicWriteValue(ip);
  const userAgent = req.headers.get("user-agent")?.trim() ?? "";

  const ipBurst = ipBurstLimiter(ip);
  if (!ipBurst.allowed) {
    logPublicWriteEvent("warn", {
      surface: "waitlist_signup",
      route: "/api/waitlist",
      outcome: "throttled",
      reason: "ip_burst",
      access: "anon_or_authenticated",
      source: WAITLIST_SIGNUP_SOURCE,
      ipHash,
      retryAfterSec: retryAfterSeconds(ipBurst.retryAfterMs),
      requestMs: Date.now() - requestStartedAtMs,
    });
    return rateLimitResponse(ipBurst.retryAfterMs);
  }

  let body: WaitlistRequestBody | null = null;
  try {
    body = await req.json() as WaitlistRequestBody;
  } catch {
    logPublicWriteEvent("warn", {
      surface: "waitlist_signup",
      route: "/api/waitlist",
      outcome: "validation_failed",
      reason: "invalid_json",
      access: "anon_or_authenticated",
      source: WAITLIST_SIGNUP_SOURCE,
      ipHash,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const normalizedEmail = email ? normalizeWaitlistEmail(email) : "";
  const emailHash = hashPublicWriteValue(normalizedEmail);
  const tier = body?.tier;

  if (!email || !isValidWaitlistEmail(email)) {
    logPublicWriteEvent("warn", {
      surface: "waitlist_signup",
      route: "/api/waitlist",
      outcome: "validation_failed",
      reason: "invalid_email",
      access: "anon_or_authenticated",
      source: WAITLIST_SIGNUP_SOURCE,
      ipHash,
      emailHash,
      tier: typeof tier === "string" ? tier : null,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
  }

  if (!isValidWaitlistTier(tier)) {
    logPublicWriteEvent("warn", {
      surface: "waitlist_signup",
      route: "/api/waitlist",
      outcome: "validation_failed",
      reason: "invalid_tier",
      access: "anon_or_authenticated",
      source: WAITLIST_SIGNUP_SOURCE,
      ipHash,
      emailHash,
      tier: typeof tier === "string" ? tier : null,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json({ ok: false, error: "Invalid waitlist tier." }, { status: 400 });
  }

  try {
    const auth = await resolveAuthContext(req);
    const clerkUserId = auth.kind === "user" ? auth.userId : null;
    const botSignals = inspectWaitlistBotSignals({
      honeypot: body?.website,
      formStartedAtMs: body?.formStartedAtMs,
      authKind: auth.kind,
    });

    if (botSignals.suspected) {
      logPublicWriteEvent("warn", {
        surface: "waitlist_signup",
        route: "/api/waitlist",
        outcome: "suspected_abuse",
        reason: botSignals.reason,
        access: auth.kind === "user" ? "authenticated" : "anon",
        source: WAITLIST_SIGNUP_SOURCE,
        authKind: auth.kind,
        ipHash,
        emailHash,
        tier,
        formAgeMs: botSignals.formAgeMs,
        hasUserAgent: userAgent.length > 0,
        requestMs: Date.now() - requestStartedAtMs,
      });
      return NextResponse.json(
        { ok: false, error: "Could not join the waitlist right now." },
        { status: 400 },
      );
    }

    const actorKey = auth.kind === "user" ? `user:${auth.userId}` : `ip:${ip}`;
    const submissionRateLimit = submissionLimiter(`${actorKey}:${normalizedEmail}:${tier}`);
    if (!submissionRateLimit.allowed) {
      logPublicWriteEvent("warn", {
        surface: "waitlist_signup",
        route: "/api/waitlist",
        outcome: "throttled",
        reason: "submission_fingerprint",
        access: auth.kind === "user" ? "authenticated" : "anon",
        source: WAITLIST_SIGNUP_SOURCE,
        authKind: auth.kind,
        ipHash,
        emailHash,
        tier,
        retryAfterSec: retryAfterSeconds(submissionRateLimit.retryAfterMs),
        hasUserAgent: userAgent.length > 0,
        requestMs: Date.now() - requestStartedAtMs,
      });
      return rateLimitResponse(submissionRateLimit.retryAfterMs);
    }

    const supabase = auth.kind === "user"
      ? await createServerSupabaseUserClient()
      : dbPublic();
    const result = await submitWaitlistSignup({
      supabase,
      email,
      tier,
      clerkUserId,
      source: WAITLIST_SIGNUP_SOURCE,
    });

    logPublicWriteEvent("info", {
      surface: "waitlist_signup",
      route: "/api/waitlist",
      outcome: result.outcome,
      access: auth.kind === "user" ? "authenticated" : "anon",
      source: WAITLIST_SIGNUP_SOURCE,
      authKind: auth.kind,
      ipHash,
      emailHash,
      tier,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    logPublicWriteEvent("error", {
      surface: "waitlist_signup",
      route: "/api/waitlist",
      outcome: "error",
      reason: error instanceof Error ? error.message : String(error),
      access: "anon_or_authenticated",
      source: WAITLIST_SIGNUP_SOURCE,
      ipHash,
      emailHash,
      tier: isValidWaitlistTier(tier) ? tier : null,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json(
      { ok: false, error: "Could not join the waitlist." },
      { status: 500 },
    );
  }
}
