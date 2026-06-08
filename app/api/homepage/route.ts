import { NextResponse } from "next/server";
import { getHomepageData } from "@/lib/data/homepage";

// Force dynamic rendering — the Cache-Control header below IS the cache. The
// underlying data changes ~once a day (the daily price-update cron), so we cache
// aggressively: fresh for 10 min, then serve STALE instantly for up to a day
// while revalidating in the background. This keeps getHomepageData()'s ~8s cold
// start off the user's critical path — they get an instant edge response and the
// cold recompute happens out of band. (A follow-up precomputes the payload so
// even that background revalidate is a cheap blob read.)
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getHomepageData();
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=600, stale-while-revalidate=86400",
    },
  });
}
