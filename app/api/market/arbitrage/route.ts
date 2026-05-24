import { NextResponse } from "next/server";
import { getJpEnArbitrageOpportunities } from "@/lib/arbitrage/jp-en-arbitrage";
import { dbPublic } from "@/lib/db";

export const runtime = "nodejs";

function readNumberParam(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readDirection(url: URL): "any" | "jp-premium" | "en-premium" {
  const direction = url.searchParams.get("direction")?.trim().toLowerCase();
  if (direction === "jp-premium" || direction === "en-premium") return direction;
  return "any";
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const result = await getJpEnArbitrageOpportunities(dbPublic(), {
      limit: readNumberParam(url, "limit"),
      scanLimit: readNumberParam(url, "scanLimit"),
      minPairConfidence: readNumberParam(url, "minPairConfidence"),
      minPriceUsd: readNumberParam(url, "minPriceUsd"),
      minPremiumPct: readNumberParam(url, "minPremiumPct"),
      estimatedFrictionPct: readNumberParam(url, "estimatedFrictionPct"),
      direction: readDirection(url),
      slug: url.searchParams.get("slug"),
    });

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("[market/arbitrage]", error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      {
        ok: false,
        error: "Internal error.",
        opportunities: [],
        coverage: null,
      },
      { status: 500 },
    );
  }
}
