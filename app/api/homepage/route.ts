import { NextResponse } from "next/server";
import { getHomepageData } from "@/lib/data/homepage";

// Force dynamic rendering — Cache-Control header below gives Vercel's edge CDN
// the same 60s effective cache as ISR did, but the build no longer pre-renders
// (and therefore no longer requires NEXT_PUBLIC_SUPABASE_* at build time).
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getHomepageData();
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
