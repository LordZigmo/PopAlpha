import { NextResponse } from "next/server";

import { dbPublic } from "@/lib/db";
import { getHomepageData, type HomepageData } from "@/lib/data/homepage";

/**
 * Public homepage signal board (consumed by iOS + the web market page).
 *
 * Served from a precomputed blob: the refresh-homepage-cache cron runs the heavy
 * getHomepageData() aggregation hourly and stores it in public.homepage_cache;
 * this route reads the newest blob via the public view public_homepage_latest (a
 * cheap LIMIT 1), so even a cold function responds in ~ms instead of the ~8s
 * cold aggregation. Falls back to a LIVE getHomepageData() if the blob is
 * missing, stale (>6h ⇒ writer wedged), or the read errors — so it never serves
 * nothing (worst case = the old pre-blob ~8s path).
 */

export const dynamic = "force-dynamic";

// Blob older than this ⇒ the writer cron is wedged; recompute live rather than
// serve very stale data. The cron runs hourly, so 6h is a wide safety margin.
const STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

type HomepageCacheRow = { payload: HomepageData; computed_at: string };

export async function GET() {
  try {
    const supabase = dbPublic();
    const { data, error } = await supabase
      .from("public_homepage_latest")
      .select("payload, computed_at")
      .maybeSingle<HomepageCacheRow>();

    if (error) {
      console.error("[api/homepage] blob read failed, serving live:", error.message);
      return NextResponse.json(await getHomepageData(), {
        headers: { "Cache-Control": CACHE_CONTROL },
      });
    }

    const fresh =
      data != null && Date.now() - Date.parse(data.computed_at) < STALE_MAX_AGE_MS;
    const body = fresh ? data.payload : await getHomepageData();
    return NextResponse.json(body, { headers: { "Cache-Control": CACHE_CONTROL } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/homepage] exception, serving live:", message);
    return NextResponse.json(await getHomepageData(), {
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  }
}
