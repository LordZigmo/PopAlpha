import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = dbPublic();
    const { data: totals, error: totalsError } = await db
      .from("public_card_page_view_totals")
      .select("canonical_slug, total_views, last_viewed_at")
      .order("last_viewed_at", { ascending: false })
      .limit(8);

    if (totalsError) throw new Error(totalsError.message);

    const slugs = (totals ?? []).map((row) => row.canonical_slug).filter(Boolean);
    if (slugs.length === 0) {
      return NextResponse.json({ ok: true, cards: [] });
    }

    const { data: cards, error: cardsError } = await db
      .from("canonical_cards")
      .select("slug, canonical_name, set_name")
      .in("slug", slugs);

    if (cardsError) throw new Error(cardsError.message);

    const cardMap = new Map(
      (cards ?? []).map((card) => [card.slug, card] as const),
    );

    const payload = (totals ?? [])
      .map((row) => {
        const card = cardMap.get(row.canonical_slug);
        if (!card) return null;
        return {
          slug: card.slug,
          name: card.canonical_name,
          set_name: card.set_name,
          total_views: row.total_views ?? 0,
          last_viewed_at: row.last_viewed_at,
        };
      })
      .filter(Boolean)
      .slice(0, 4);

    return NextResponse.json({ ok: true, cards: payload });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error), cards: [] },
      { status: 500 },
    );
  }
}
