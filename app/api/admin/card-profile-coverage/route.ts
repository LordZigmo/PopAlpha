/**
 * Admin: card-profile-coverage
 *
 * Read-only operator dashboard for the card_profiles fallback drain.
 * Answers two questions in one round-trip:
 *
 *   1. How many cards are on `source = 'fallback'` vs `'llm'`, and how
 *      fast is the cron upgrading them (24h / 7d delta)?
 *   2. Of cards currently on fallback, why did they get there
 *      (top-N failure_reason buckets)?
 *
 * Backed by the two views added in
 * 20260503120000_card_profiles_failure_reason_and_coverage.sql:
 *   public.card_profile_coverage
 *   public.card_profile_failure_buckets
 *
 *   curl -H "Authorization: Bearer $ADMIN_SECRET" \
 *     https://popalpha.ai/api/admin/card-profile-coverage
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CoverageRow = {
  source: string;
  profile_count: number;
  updated_24h: number;
  updated_7d: number;
  with_failure_reason: number;
};

type BucketRow = {
  bucket: string;
  count: number;
};

const TOP_N_FAILURE_BUCKETS = 10;

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();

  const [coverageResult, bucketsResult] = await Promise.all([
    supabase.from("card_profile_coverage").select("*"),
    supabase
      .from("card_profile_failure_buckets")
      .select("*")
      .limit(TOP_N_FAILURE_BUCKETS),
  ]);

  if (coverageResult.error) {
    return NextResponse.json(
      { ok: false, error: `card_profile_coverage read failed: ${coverageResult.error.message}` },
      { status: 500 },
    );
  }
  if (bucketsResult.error) {
    return NextResponse.json(
      { ok: false, error: `card_profile_failure_buckets read failed: ${bucketsResult.error.message}` },
      { status: 500 },
    );
  }

  const rows = (coverageResult.data ?? []) as CoverageRow[];
  const llm = rows.find((r) => r.source === "llm");
  const fallback = rows.find((r) => r.source === "fallback");

  const llmCount = llm?.profile_count ?? 0;
  const fallbackCount = fallback?.profile_count ?? 0;
  const total = llmCount + fallbackCount;
  const fallbackPct = total > 0 ? Math.round((fallbackCount / total) * 1000) / 10 : 0;

  return NextResponse.json({
    ok: true,
    totals: {
      llm: llmCount,
      fallback: fallbackCount,
      total,
      fallback_pct: fallbackPct,
    },
    recency: {
      llm_updated_24h: llm?.updated_24h ?? 0,
      llm_updated_7d: llm?.updated_7d ?? 0,
      fallback_updated_24h: fallback?.updated_24h ?? 0,
      fallback_updated_7d: fallback?.updated_7d ?? 0,
    },
    failure_reasons: {
      with_reason: fallback?.with_failure_reason ?? 0,
      top_buckets: (bucketsResult.data ?? []) as BucketRow[],
    },
  });
}
