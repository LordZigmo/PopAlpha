import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { fetchJustTcgCards, type JustTcgCard } from "@/lib/providers/justtcg";

export async function GET(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const setId = searchParams.get("set");
  const q = searchParams.get("q") ?? null;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "1", 10), 10);

  if (!setId) {
    return NextResponse.json(
      { error: "?set= required. Example: ?set=base-set-pokemon" },
      { status: 400 }
    );
  }

  try {
    const { cards, hasMore, rawEnvelope, httpStatus } = await fetchJustTcgCards(setId, 1);

    // Optional in-memory filter by card name.
    let filtered = cards;
    if (q) {
      const lower = q.toLowerCase();
      filtered = cards.filter((c) => c.name.toLowerCase().includes(lower));
    }

    // Trim to requested limit and trim priceHistory to 5 points for readability.
    const trimmed = filtered.slice(0, limit).map((card: JustTcgCard) => ({
      id: card.id,
      name: card.name,
      number: card.number,
      set: card.set,
      set_name: card.set_name,
      rarity: card.rarity,
      variants: card.variants.slice(0, 3).map((v) => ({
        id: v.id,
        condition: v.condition,
        printing: v.printing,
        language: v.language,
        price: v.price,
        priceChange7d: v.priceChange7d,
        priceChange30d: v.priceChange30d,
        trendSlope7d: v.trendSlope7d,
        priceRelativeTo30dRange: v.priceRelativeTo30dRange,
        priceHistory: v.priceHistory?.slice(-5),
      })),
    }));

    const envelope = rawEnvelope as Record<string, unknown>;

    return NextResponse.json({
      ok: true,
      deprecatedQueryAuth: auth.deprecatedQueryAuth,
      httpStatus,
      meta: (envelope._metadata as unknown) ?? null,
      pagination: (envelope.meta as unknown) ?? null,
      totalInPage: cards.length,
      hasMore,
      filteredCount: filtered.length,
      cards: trimmed,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
