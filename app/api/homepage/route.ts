import { NextResponse } from "next/server";
import { getHomepageData } from "@/lib/data/homepage";

// Match the homepage ISR window so web and iOS see the same cached payload.
export const revalidate = 60;

export async function GET() {
  const data = await getHomepageData();
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
