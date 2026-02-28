import { NextResponse } from "next/server";
import { normalizeSetName, searchTcgTrackingSets } from "@/lib/tcgtracking";

export const runtime = "nodejs";

function parseCategory(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (parsed === 85) return 85;
  return 3;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return NextResponse.json({ ok: false, error: "Missing q query param." }, { status: 400 });
  }

  const cat = parseCategory(url.searchParams.get("cat"));

  try {
    const payload = await searchTcgTrackingSets({
      cat,
      query: q,
      setName: q,
      setCode: q,
    });

    return NextResponse.json(
      {
        ok: true,
        cat,
        q,
        normalizedQuery: normalizeSetName(q),
        candidates: payload.candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          code: candidate.code,
          year: candidate.year,
        })),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300",
        },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load TCGTracking set candidates.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
