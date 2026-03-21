import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";
import { getCommunityVoteWeekStart } from "@/lib/data/community-pulse";

export const runtime = "nodejs";

type VoteRow = {
  canonical_slug: string;
  bullish_votes: number;
  bearish_votes: number;
};

export async function GET() {
  try {
    const db = dbPublic();
    const weekStart = getCommunityVoteWeekStart();

    const { data: votes, error } = await db
      .from("public_community_vote_totals")
      .select("canonical_slug, bullish_votes, bearish_votes")
      .eq("week_start", weekStart)
      .limit(500);

    if (error) throw new Error(error.message);

    const tallies = new Map<string, { up: number; down: number }>();
    for (const row of (votes ?? []) as VoteRow[]) {
      if (!row.canonical_slug) continue;
      tallies.set(row.canonical_slug, {
        up: row.bullish_votes ?? 0,
        down: row.bearish_votes ?? 0,
      });
    }

    const candidates = [...tallies.entries()]
      .map(([slug, counts]) => {
        const total = counts.up + counts.down;
        const upPct = total > 0 ? (counts.up / total) * 100 : 0;
        return { slug, total, upPct };
      })
      .filter((entry) => entry.total > 0 && entry.upPct >= 80)
      .sort((a, b) => {
        if (b.upPct !== a.upPct) return b.upPct - a.upPct;
        return b.total - a.total;
      })
      .slice(0, 3);

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, cards: [] });
    }

    const slugs = candidates.map((entry) => entry.slug);
    const { data: cards, error: cardError } = await db
      .from("canonical_cards")
      .select("slug, canonical_name, set_name")
      .in("slug", slugs);

    if (cardError) throw new Error(cardError.message);

    const cardMap = new Map((cards ?? []).map((row) => [row.slug, row] as const));

    return NextResponse.json({
      ok: true,
      cards: candidates.map((entry) => {
        const card = cardMap.get(entry.slug);
        return {
          slug: entry.slug,
          name: card?.canonical_name ?? entry.slug,
          set_name: card?.set_name ?? null,
          up_pct: Math.round(entry.upPct),
          vote_count: entry.total,
        };
      }),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error), cards: [] },
      { status: 500 },
    );
  }
}
