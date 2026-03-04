import { NextResponse } from "next/server";
import { getCommunityVoteWeekStart } from "@/lib/data/community-pulse";
import { dbPublic } from "@/lib/db";

export const runtime = "nodejs";

type VoteRow = {
  canonical_slug: string;
  vote_side: "up" | "down";
};

type ViewRow = {
  canonical_slug: string;
  total_views: number;
};

export async function GET() {
  try {
    const db = dbPublic();
    const weekStart = getCommunityVoteWeekStart();

    const [{ data: votes, error: voteError }, { data: views, error: viewsError }] = await Promise.all([
      db
        .from("community_card_votes")
        .select("canonical_slug, vote_side")
        .eq("week_start", weekStart)
        .limit(1000),
      db
        .from("public_card_page_view_totals")
        .select("canonical_slug, total_views")
        .order("total_views", { ascending: false })
        .limit(30),
    ]);

    if (voteError) throw new Error(voteError.message);
    if (viewsError) throw new Error(viewsError.message);

    const voteMap = new Map<string, { up: number; down: number }>();
    for (const row of (votes ?? []) as VoteRow[]) {
      if (!row.canonical_slug) continue;
      const bucket = voteMap.get(row.canonical_slug) ?? { up: 0, down: 0 };
      if (row.vote_side === "up") bucket.up += 1;
      else bucket.down += 1;
      voteMap.set(row.canonical_slug, bucket);
    }

    const viewMap = new Map<string, number>();
    for (const row of (views ?? []) as ViewRow[]) {
      if (row.canonical_slug) viewMap.set(row.canonical_slug, row.total_views ?? 0);
    }
    const allSlugs = [...new Set([
      ...voteMap.keys(),
      ...viewMap.keys(),
    ])];

    const { data: cards, error: cardsError } = allSlugs.length > 0
      ? await db
          .from("canonical_cards")
          .select("slug, canonical_name, set_name")
          .in("slug", allSlugs)
      : { data: [], error: null };

    if (cardsError) throw new Error(cardsError.message);

    const cardMap = new Map((cards ?? []).map((row) => [row.slug, row] as const));

    const bullishLeader = [...voteMap.entries()]
      .map(([slug, counts]) => {
        const total = counts.up + counts.down;
        const upPct = total > 0 ? (counts.up / total) * 100 : 0;
        return { slug, upPct, total };
      })
      .filter((entry) => entry.total > 0)
      .sort((a, b) => {
        if (b.upPct !== a.upPct) return b.upPct - a.upPct;
        return b.total - a.total;
      })[0] ?? null;

    const mostWatched = [...viewMap.entries()]
      .sort((a, b) => b[1] - a[1])[0] ?? null;

    const divergence = [...viewMap.entries()]
      .map(([slug, totalViews]) => {
        const counts = voteMap.get(slug) ?? { up: 0, down: 0 };
        const totalVotes = counts.up + counts.down;
        return { slug, totalViews, totalVotes };
      })
      .sort((a, b) => {
        const scoreA = a.totalViews - a.totalVotes * 5;
        const scoreB = b.totalViews - b.totalVotes * 5;
        return scoreB - scoreA;
      })[0] ?? null;

    return NextResponse.json({
      ok: true,
      bullishLeader: bullishLeader ? {
        slug: bullishLeader.slug,
        name: cardMap.get(bullishLeader.slug)?.canonical_name ?? bullishLeader.slug,
        set_name: cardMap.get(bullishLeader.slug)?.set_name ?? null,
        up_pct: Math.round(bullishLeader.upPct),
        vote_count: bullishLeader.total,
      } : null,
      mostWatched: mostWatched ? {
        slug: mostWatched[0],
        name: cardMap.get(mostWatched[0])?.canonical_name ?? mostWatched[0],
        set_name: cardMap.get(mostWatched[0])?.set_name ?? null,
        add_count: Math.max(3, Math.min(24, Math.round((mostWatched[1] ?? 0) * 1.4))),
      } : null,
      divergence: divergence ? {
        slug: divergence.slug,
        name: cardMap.get(divergence.slug)?.canonical_name ?? divergence.slug,
        set_name: cardMap.get(divergence.slug)?.set_name ?? null,
        total_views: divergence.totalViews,
        vote_count: divergence.totalVotes,
      } : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        bullishLeader: null,
        mostWatched: null,
        divergence: null,
      },
      { status: 500 },
    );
  }
}
