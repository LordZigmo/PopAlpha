import { NextResponse } from "next/server";
import { getHomepageData } from "@/lib/data/homepage";

// Force dynamic rendering — the Cache-Control header below IS the cache. The
// signal board changes ~once a day (the daily price cron), but the JP price
// rails refresh hourly, so we cap staleness UNDER that hourly cadence: fresh
// 10 min, then serve stale up to ~45 min while revalidating in the background.
// That keeps getHomepageData()'s ~8s cold start off the user's critical path
// without letting hourly JP prices go stale. (A follow-up precomputes the
// payload so the read is cheap and this window can shrink back to seconds.)
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getHomepageData();
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=600, stale-while-revalidate=2700",
    },
  });
}
