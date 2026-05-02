import { NextResponse } from "next/server";

import { dbPublic } from "@/lib/db";

/**
 * Public endpoint: returns the single most recent cached AI Brief.
 *
 * The brief is regenerated on a schedule by /api/cron/refresh-ai-brief
 * and stored in public.ai_brief_cache. This route reads from the public
 * view public.public_ai_brief_latest (granted to anon + authenticated)
 * so iOS and web both hit the same cached payload.
 *
 * Cache headers mirror /api/homepage (60s ISR + 5min SWR) so the brief
 * stays aligned with the mover data it summarizes.
 *
 * If no brief has been generated yet (fresh install, cron hasn't run),
 * this route returns 200 with { ok: true, brief: null } so clients can
 * render their own placeholder instead of 404ing.
 */

// Force dynamic rendering — Cache-Control header below gives Vercel's edge CDN
// the same 60s effective cache as ISR did, but the build no longer pre-renders
// (and therefore no longer requires NEXT_PUBLIC_SUPABASE_* at build time).
export const dynamic = "force-dynamic";

type AiBriefRow = {
  version: string;
  summary: string;
  takeaway: string;
  focus_set: string | null;
  model_label: string;
  source: string;
  data_as_of: string | null;
  generated_at: string;
};

export async function GET() {
  try {
    const supabase = dbPublic();
    const { data, error } = await supabase
      .from("public_ai_brief_latest")
      .select("version, summary, takeaway, focus_set, model_label, source, data_as_of, generated_at")
      .maybeSingle<AiBriefRow>();

    if (error) {
      console.error("[api/homepage/ai-brief] read failed:", error.message);
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json(
        { ok: true, brief: null },
        {
          headers: {
            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
          },
        },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        brief: {
          version: data.version,
          summary: data.summary,
          takeaway: data.takeaway,
          focus_set: data.focus_set,
          model_label: data.model_label,
          source: data.source,
          data_as_of: data.data_as_of,
          generated_at: data.generated_at,
        },
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/homepage/ai-brief] exception:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
