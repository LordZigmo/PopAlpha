import { NextResponse } from "next/server";
import { getCachedTcgSetPricing } from "@/lib/tcgtracking";

export const runtime = "nodejs";

function parseCategory(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (parsed === 85) return 85;
  return 3;
}

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 250);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const setId = url.searchParams.get("setId")?.trim() ?? "";
  if (!setId) {
    return NextResponse.json({ ok: false, error: "Missing setId query param." }, { status: 400 });
  }

  const cat = parseCategory(url.searchParams.get("cat"));
  const limit = parseLimit(url.searchParams.get("limit"));

  try {
    const payload = await getCachedTcgSetPricing({ cat, setId, limit });
    return NextResponse.json(
      {
        ok: true,
        ...payload,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=3600",
        },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load TCG pricing.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
