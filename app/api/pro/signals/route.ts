import { NextResponse } from "next/server";
import { requireOnboarded } from "@/lib/auth/require";
import { hasPro } from "@/lib/entitlements";
import { dbAdmin } from "@/lib/db/admin";
import { createRateLimiter } from "@/lib/rate-limit";
import { getPostHogClient } from "@/lib/posthog-server";
import { ANALYTICS_PIPELINE_PROVIDERS } from "@/lib/backfill/provider-registry";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
const ACTIVE_SIGNAL_PROVIDER = ANALYTICS_PIPELINE_PROVIDERS[0];

// Accepted grade values. Mirrors the bucket vocabulary used by
// pro_variant_metrics and refresh_card_metrics_for_variants. Any other
// value returns 400 — never default-to-RAW on an unrecognized grade
// (same anti-default principle as the scrydex normalizer's
// normalizeScrydexCondition).
const ACCEPTED_GRADES = new Set([
  "RAW",
  "LE_7",
  "G8",
  "G9",
  "G9_5",
  "G10",
  "G10_PERFECT",
]);

/**
 * Serves signal data only to entitled users.
 * Reads pro_variant_metrics (no anon grant) via dbAdmin().
 * Returns 403 if the user does not have a pro entitlement.
 *
 * Usage: GET /api/pro/signals?slug=<canonical_slug>&grade=<bucket>
 *   - grade defaults to RAW; accepts RAW, LE_7, G8, G9, G9_5, G10, G10_PERFECT
 *   - graded grades return one row per (provider × grade) pair — variant_ref
 *     carries the grader (e.g. `<printing>::PSA::10`, `<printing>::CGC::10`).
 *     The UI is responsible for parsing variant_ref to attribute signals to
 *     specific graders.
 *
 * Phase 4 of docs/graded-surfacing-plan.md (shipped 2026-05-16): the prior
 * short-circuit returning empty for graded grades was based on the
 * Phase 0 finding that 0 of 58,586 graded rows had non-null signal_trend
 * (caused by a script bug — see plan doc for details). Current prod has
 * 25,174 graded rows across grades with non-null signal_trend.
 */
export async function GET(req: Request) {
  // 1. Auth (cheap) → 2. Entitlement (cheap) → 3. Rate limit
  // Non-pro users reject before touching the limiter so they can't burn tokens.
  const auth = await requireOnboarded(req);
  if (!auth.ok) return auth.response;

  if (!(await hasPro(auth.userId))) {
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

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug")?.trim();
  const grade = (url.searchParams.get("grade")?.trim() ?? "RAW").toUpperCase();
  if (!slug) {
    return NextResponse.json(
      { ok: false, error: "Missing slug query param." },
      { status: 400 },
    );
  }
  if (!ACCEPTED_GRADES.has(grade)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unsupported grade '${grade}'. Accepted: ${[...ACCEPTED_GRADES].join(", ")}.`,
      },
      { status: 400 },
    );
  }

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("pro_variant_metrics")
    .select("variant_ref, signal_trend, signal_breakout, signal_value, signals_as_of_ts")
    .eq("canonical_slug", slug)
    .eq("provider", ACTIVE_SIGNAL_PROVIDER)
    .eq("grade", grade)
    .not("signal_trend", "is", null)
    .order("history_points_30d", { ascending: false })
    .limit(10);

  if (error) {
    console.error("[pro/signals]", slug, grade, error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  // Engagement metric for the headline Pro feature — measures how
  // often paying users actually exercise the gated capability they're
  // paying for. Useful for cross-referencing churn: pro users who
  // never access signals are higher-risk for non-renewal.
  getPostHogClient().capture({
    distinctId: auth.userId,
    event: "pro_signals_accessed",
    properties: {
      canonical_slug: slug,
      grade,
      provider: ACTIVE_SIGNAL_PROVIDER,
      variant_count: data?.length ?? 0,
    },
  });

  return NextResponse.json({ ok: true, slug, grade, provider: ACTIVE_SIGNAL_PROVIDER, variants: data });
}
