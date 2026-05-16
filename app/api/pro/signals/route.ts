import { NextResponse } from "next/server";
import { requireOnboarded } from "@/lib/auth/require";
import { hasPro } from "@/lib/entitlements";
import { dbAdmin } from "@/lib/db/admin";
import { createRateLimiter } from "@/lib/rate-limit";
import { getPostHogClient } from "@/lib/posthog-server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });

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
 *     UI is responsible for parsing variant_ref to attribute signals to
 *     specific graders.
 *
 * Provider handling: signals are computed under the provider responsible
 * for the price series (JUSTTCG for RAW; PSA/CGC/BGS/TAG for graded).
 * The route doesn't filter by provider — `signal_trend IS NOT NULL`
 * already restricts to rows the calculator has emitted, regardless of
 * which provider produced the underlying snapshots. Response includes
 * the distinct providers in `providers` so the client can attribute.
 *
 * Phase 4 of docs/graded-surfacing-plan.md (shipped 2026-05-16): the
 * prior short-circuit returning empty for graded grades was based on a
 * stale Phase 0 finding. The same change also fixed a long-standing
 * RAW bug — the route had been filtering `provider = 'SCRYDEX'` since
 * inception, but signals for RAW live under `JUSTTCG`, so the RAW path
 * also returned zero rows. Codex P1 on PR #102.
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
    .select("variant_ref, provider, signal_trend, signal_breakout, signal_value, signals_as_of_ts")
    .eq("canonical_slug", slug)
    .eq("grade", grade)
    .not("signal_trend", "is", null)
    .order("history_points_30d", { ascending: false })
    .limit(10);

  if (error) {
    console.error("[pro/signals]", slug, grade, error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  type VariantRow = {
    variant_ref: string | null;
    provider: string | null;
    signal_trend: string | number | null;
    signal_breakout: string | number | null;
    signal_value: string | number | null;
    signals_as_of_ts: string | null;
  };
  const variants = (data ?? []) as VariantRow[];
  const providers = [
    ...new Set(
      variants
        .map((row) => row.provider)
        .filter((provider): provider is string => Boolean(provider)),
    ),
  ];

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
      providers,
      variant_count: variants.length,
    },
  });

  return NextResponse.json({ ok: true, slug, grade, providers, variants });
}
