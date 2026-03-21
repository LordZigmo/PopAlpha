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

export const runtime = "nodejs";

const ipBurstLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
const slugLimiter = createRateLimiter({ windowMs: 10 * 60_000, maxRequests: 12 });

function rateLimitResponse(retryAfterMs: number) {
  return new NextResponse(
    JSON.stringify({ ok: false, error: "Too many card view events. Please try again shortly." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds(retryAfterMs)),
      },
    },
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const requestStartedAtMs = Date.now();
  const ip = getPublicWriteIp(req);
  const ipHash = hashPublicWriteValue(ip);
  const fetchSite = getPublicWriteFetchSite(req);
  const userAgent = req.headers.get("user-agent")?.trim() ?? "";
  const { slug } = await params;
  const canonicalSlug = typeof slug === "string" ? slug.trim() : "";
  const slugHash = hashPublicWriteValue(canonicalSlug);

  if (!canonicalSlug) {
    logPublicWriteEvent("warn", {
      surface: "card_page_view",
      route: "/api/cards/[slug]/view",
      outcome: "validation_failed",
      reason: "missing_slug",
      access: "anon_or_authenticated",
      ipHash,
      slugHash,
      fetchSite,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json({ ok: false, error: "Missing card slug." }, { status: 400 });
  }

  if (isCrossSitePublicWrite(req)) {
    logPublicWriteEvent("warn", {
      surface: "card_page_view",
      route: "/api/cards/[slug]/view",
      outcome: "suspected_abuse",
      reason: "cross_site_fetch",
      access: "anon_or_authenticated",
      ipHash,
      slugHash,
      fetchSite,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json({ ok: false, error: "Could not record card view." }, { status: 400 });
  }

  const ipBurst = ipBurstLimiter(ip);
  if (!ipBurst.allowed) {
    logPublicWriteEvent("warn", {
      surface: "card_page_view",
      route: "/api/cards/[slug]/view",
      outcome: "throttled",
      reason: "ip_burst",
      access: "anon_or_authenticated",
      ipHash,
      slugHash,
      fetchSite,
      retryAfterSec: retryAfterSeconds(ipBurst.retryAfterMs),
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return rateLimitResponse(ipBurst.retryAfterMs);
  }

  const slugRateLimit = slugLimiter(`${ip}:${canonicalSlug}`);
  if (!slugRateLimit.allowed) {
    logPublicWriteEvent("warn", {
      surface: "card_page_view",
      route: "/api/cards/[slug]/view",
      outcome: "throttled",
      reason: "slug_fingerprint",
      access: "anon_or_authenticated",
      ipHash,
      slugHash,
      fetchSite,
      retryAfterSec: retryAfterSeconds(slugRateLimit.retryAfterMs),
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return rateLimitResponse(slugRateLimit.retryAfterMs);
  }

  try {
    const supabase = dbAdmin();
    const { error } = await supabase
      .from("card_page_views")
      .insert({ canonical_slug: canonicalSlug });

    if (error) {
      const status = error.code === "23503" ? 404 : 500;
      logPublicWriteEvent(error.code === "23503" ? "warn" : "error", {
        surface: "card_page_view",
        route: "/api/cards/[slug]/view",
        outcome: error.code === "23503" ? "validation_failed" : "error",
        reason: error.code === "23503" ? "unknown_slug" : error.message,
        access: "anon_or_authenticated",
        ipHash,
        slugHash,
        fetchSite,
        hasUserAgent: userAgent.length > 0,
        requestMs: Date.now() - requestStartedAtMs,
      });
      return NextResponse.json({ ok: false, error: error.message }, { status });
    }

    logPublicWriteEvent("info", {
      surface: "card_page_view",
      route: "/api/cards/[slug]/view",
      outcome: "accepted",
      access: "anon_or_authenticated",
      ipHash,
      slugHash,
      fetchSite,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    logPublicWriteEvent("error", {
      surface: "card_page_view",
      route: "/api/cards/[slug]/view",
      outcome: "error",
      reason: error instanceof Error ? error.message : String(error),
      access: "anon_or_authenticated",
      ipHash,
      slugHash,
      fetchSite,
      hasUserAgent: userAgent.length > 0,
      requestMs: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json(
      { ok: false, error: "Could not record card view." },
      { status: 500 },
    );
  }
}
