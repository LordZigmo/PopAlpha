import { NextResponse, type NextRequest } from "next/server";
import {
  PUBLIC_ROUTES,
  CRON_ROUTES,
  ADMIN_ROUTES,
  INGEST_ROUTES,
  USER_ROUTES,
} from "@/lib/auth/route-registry";

// ── Route classification sets ────────────────────────────────────────────────
// Single source of truth lives in lib/auth/route-registry.ts.
// Build-time coverage check: scripts/check-route-coverage.mjs

const PUBLIC_SET = new Set(PUBLIC_ROUTES);
const CRON_SET = new Set(CRON_ROUTES);
const ADMIN_SET = new Set(ADMIN_ROUTES);
const INGEST_SET = new Set(INGEST_ROUTES);
const USER_SET = new Set(USER_ROUTES);

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
  const segments = stripped.split("/");

  // Known patterns with dynamic segments:
  // cards/[slug]/detail → segment[1] is the slug
  // private-sales/[id] → segment[1] is the id
  if (segments[0] === "cards" && segments.length === 3 && segments[2] === "detail") {
    return "cards/[slug]/detail";
  }
  if (segments[0] === "private-sales" && segments.length === 2 && segments[1] !== "") {
    return "private-sales/[id]";
  }

  return stripped;
}

type RouteClass = "public" | "cron" | "admin" | "ingest" | "user" | "debug" | "page-auth" | "unknown";

function classifyRoute(pathname: string): RouteClass {
  // API routes
  if (pathname.startsWith("/api/")) {
    // Debug routes — entire subtree
    if (pathname.startsWith("/api/debug/")) return "debug";

    const key = toRouteKey(pathname);
    if (PUBLIC_SET.has(key)) return "public";
    if (CRON_SET.has(key)) return "cron";
    if (ADMIN_SET.has(key)) return "admin";
    if (INGEST_SET.has(key)) return "ingest";
    if (USER_SET.has(key)) return "user";

    return "unknown";
  }

  // Page routes
  if (pathname === "/portfolio") return "page-auth";

  return "unknown";
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
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

  // Unknown routes: deny by default
  if (routeClass === "unknown") {
    return NextResponse.json(
      { ok: false, error: "Not found." },
      { status: 404 },
    );
  }

  // All classified routes: pass through with x-route-class header
  const response = NextResponse.next();
  response.headers.set("x-route-class", routeClass);
  return response;
}

// Only run middleware on API routes and specific pages
export const config = {
  matcher: ["/api/:path*", "/portfolio"],
};
