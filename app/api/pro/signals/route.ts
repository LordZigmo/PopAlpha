import { NextResponse } from "next/server";
import { requireOnboarded } from "@/lib/auth/require";
import { hasPro } from "@/lib/entitlements";
import { dbAdmin } from "@/lib/db/admin";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });

/**
 * Serves signal data only to entitled users.
 * Reads pro_variant_metrics (no anon grant) via dbAdmin().
 * Returns 403 if the user does not have a pro entitlement.
 *
 * Usage: GET /api/pro/signals?slug=<canonical_slug>
 */
export async function GET(req: Request) {
  // 1. Auth (cheap) → 2. Entitlement (cheap) → 3. Rate limit
  // Non-pro users reject before touching the limiter so they can't burn tokens.
  const auth = await requireOnboarded(req);
  if (!auth.ok) return auth.response;

  if (!hasPro(auth.userId)) {
    return NextResponse.json(
      { ok: false, error: "Pro subscription required." },
      { status: 403 },
    );
  }

  const rl = rateLimiter(auth.userId);
  if (!rl.allowed) {
    console.warn("[pro/signals] rate-limited", { userId: auth.userId });
    return new NextResponse(
      JSON.stringify({ ok: false, error: "Rate limit exceeded." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
        },
      },
    );
  }

  const slug = new URL(req.url).searchParams.get("slug")?.trim();
  if (!slug) {
    return NextResponse.json(
      { ok: false, error: "Missing slug query param." },
      { status: 400 },
    );
  }

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("pro_variant_metrics")
    .select("variant_ref, signal_trend, signal_breakout, signal_value, signals_as_of_ts")
    .eq("canonical_slug", slug)
    .eq("provider", "JUSTTCG")
    .eq("grade", "RAW")
    .not("signal_trend", "is", null)
    .order("history_points_30d", { ascending: false })
    .limit(10);

  if (error) {
    console.error("[pro/signals]", slug, error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, slug, variants: data });
}
