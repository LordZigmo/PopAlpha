// Next.js 16 middleware entrypoint (renamed from middleware.ts → proxy.ts).
// This file is bundled separately from the app directory. Vercel's build
// cache occasionally skips rebuilding the middleware bundle when only the
// imported route-registry changes, which leaves stale PUBLIC/ADMIN/… sets
// in production even after the new route files deploy. Symptom: new API
// routes return 404 from this middleware's "unknown" branch instead of
// reaching the route handler. If you see that, a whitespace/comment
// bump in this file forces a full middleware rebuild.
// (bump 2: cron/backfill-card-image-digital-flag — 2026-04-24)
// (bump 3: _diag/auth temp diagnostic — 2026-04-27)
// (bump 4: rename _diag → diag — 2026-04-27)
// (bump 5: remove diag/auth after admin-elevation fix — 2026-04-27)
// (bump 6: admin/cleanup/delete-thumb-overlay-augs — 2026-04-29)

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import {
  PUBLIC_ROUTES,
  CRON_ROUTES,
  ADMIN_ROUTES,
  DEBUG_ROUTES,
  INGEST_ROUTES,
  USER_ROUTES,
} from "@/lib/auth/route-registry";

// ── Route classification sets ────────────────────────────────────────────────
// Single source of truth lives in lib/auth/route-registry.ts.
// Build-time coverage check: scripts/check-route-coverage.mjs

const PUBLIC_SET = new Set(PUBLIC_ROUTES);
const CRON_SET = new Set(CRON_ROUTES);
const ADMIN_SET = new Set(ADMIN_ROUTES);
const DEBUG_SET = new Set(DEBUG_ROUTES);
const INGEST_SET = new Set(INGEST_ROUTES);
const USER_SET = new Set(USER_ROUTES);
const ALL_ROUTE_KEYS = [
  ...PUBLIC_ROUTES,
  ...CRON_ROUTES,
  ...ADMIN_ROUTES,
  ...DEBUG_ROUTES,
  ...INGEST_ROUTES,
  ...USER_ROUTES,
];
const ALL_ROUTE_SET = new Set(ALL_ROUTE_KEYS);
const DYNAMIC_ROUTE_PATTERNS = ALL_ROUTE_KEYS
  .filter((routeKey) => routeKey.includes("["))
  .map((routeKey) => ({
    routeKey,
    segments: routeKey.split("/"),
    staticSegmentCount: routeKey.split("/").filter((segment) => !(segment.startsWith("[") && segment.endsWith("]"))).length,
  }))
  .sort((a, b) => b.staticSegmentCount - a.staticSegmentCount);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize an API pathname into a route key that matches our classification sets.
 * Replaces dynamic segments (UUIDs, slugs) with [param].
 *
 * Example: "/api/cards/base-set-1-charizard/detail" → "cards/[slug]/detail"
 *          "/api/private-sales/abc-123" → "private-sales/[id]"
 */
function toRouteKey(pathname: string): string {
  // Strip /api/ prefix
  const stripped = pathname.replace(/^\/api\//, "");
  if (ALL_ROUTE_SET.has(stripped)) {
    return stripped;
  }

  const segments = stripped.split("/");
  for (const pattern of DYNAMIC_ROUTE_PATTERNS) {
    if (pattern.segments.length !== segments.length) continue;

    const matches = pattern.segments.every((patternSegment, index) => {
      if (patternSegment.startsWith("[") && patternSegment.endsWith("]")) {
        return segments[index] !== "";
      }
      return patternSegment === segments[index];
    });

    if (matches) {
      return pattern.routeKey;
    }
  }

  return stripped;
}

type RouteClass = "public" | "cron" | "admin" | "debug" | "ingest" | "user" | "page-auth" | "unknown";

function classifyRoute(pathname: string): RouteClass {
  // API routes
  if (pathname.startsWith("/api/")) {
    const key = toRouteKey(pathname);
    if (PUBLIC_SET.has(key)) return "public";
    if (CRON_SET.has(key)) return "cron";
    if (ADMIN_SET.has(key)) return "admin";
    if (DEBUG_SET.has(key)) return "debug";
    if (INGEST_SET.has(key)) return "ingest";
    if (USER_SET.has(key)) return "user";

    return "unknown";
  }

  // Page routes
  if (pathname === "/portfolio") return "page-auth";
  if (pathname.startsWith("/onboarding")) return "page-auth";

  return "unknown";
}

// ── Protected page routes (require Clerk sign-in) ───────────────────────────

const isProtectedRoute = createRouteMatcher(["/portfolio(.*)", "/onboarding(.*)"]);

// ── Clerk handler ───────────────────────────────────────────────────────────

const clerkHandler = clerkMiddleware(async (auth, req: NextRequest) => {
  const { pathname } = req.nextUrl;

  // Canonicalize mixed-case page route aliases.
  if (pathname === "/Data") {
    return NextResponse.redirect(new URL("/data", req.url), 308);
  }

  // Only classify API routes and protected pages — other pages pass through
  if (pathname.startsWith("/api/") || pathname === "/portfolio" || pathname.startsWith("/onboarding")) {
    const routeClass = classifyRoute(pathname);

    // Debug routes: block in production unless ALLOW_DEBUG_IN_PROD=1
    if (routeClass === "debug") {
      const isProd = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
      const allowed = process.env.ALLOW_DEBUG_IN_PROD === "1";
      if (isProd && !allowed) {
        return NextResponse.json(
          { ok: false, error: "Debug routes are disabled in production." },
          { status: 403 },
        );
      }
    }

    // Unknown API routes: deny by default
    if (routeClass === "unknown" && pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Not found." },
        { status: 404 },
      );
    }

    // All classified routes: tag with x-route-class header
    const response = NextResponse.next();
    response.headers.set("x-route-class", routeClass);

    // Protected page routes: require Clerk auth
    if (isProtectedRoute(req)) {
      await auth.protect();
    }

    return response;
  }

  // Protected page routes outside API (shouldn't happen given matcher, but safe)
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

// ── Exported middleware — wraps Clerk with error handling ────────────────────

export default async function proxy(req: NextRequest, event: unknown) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (clerkHandler as any)(req, event);
  } catch (err) {
    console.error("[proxy] middleware error:", err);

    // If the Clerk handshake failed, strip the param and redirect to the
    // clean URL so the user sees the page as a guest instead of a 500.
    const url = req.nextUrl.clone();
    if (url.searchParams.has("__clerk_handshake")) {
      url.searchParams.delete("__clerk_handshake");
      console.error("[proxy] Clerk handshake failed — redirecting to clean URL");
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  }
}

// Match API routes, protected pages, sign-in/sign-up, and all non-static routes
// for Clerk session resolution.
export const config = {
  matcher: [
    "/api/:path*",
    "/portfolio",
    "/onboarding(.*)",
    "/sign-in(.*)",
    "/sign-up(.*)",
    // Clerk: match all routes except static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
