import { NextResponse } from "next/server";
import { getCommunityVoteWeekStart } from "@/lib/data/community-pulse";
import { dbPublic } from "@/lib/db";
import { isPhysicalPokemonSet } from "@/lib/sets/physical";

export const runtime = "nodejs";

type VoteRow = {
  canonical_slug: string;
  bullish_votes: number;
  bearish_votes: number;
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
        .from("public_community_vote_totals")
        .select("canonical_slug, bullish_votes, bearish_votes")
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
      voteMap.set(row.canonical_slug, {
        up: row.bullish_votes ?? 0,
        down: row.bearish_votes ?? 0,
      });
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

    const cardMap = new Map(
      (cards ?? [])
        .filter((row) => isPhysicalPokemonSet({ setName: row.set_name }))
        .map((row) => [row.slug, row] as const),
    );

    const bullishLeader = [...voteMap.entries()]
      .map(([slug, counts]) => {
        const total = counts.up + counts.down;
        const upPct = total > 0 ? (counts.up / total) * 100 : 0;
        return { slug, upPct, total };
      })
      .filter((entry) => entry.total > 0 && cardMap.has(entry.slug))
      .sort((a, b) => {
        if (b.upPct !== a.upPct) return b.upPct - a.upPct;
        return b.total - a.total;
      })[0] ?? null;

    const mostWatched = [...viewMap.entries()]
      .filter(([slug]) => cardMap.has(slug))
      .sort((a, b) => b[1] - a[1])[0] ?? null;

    const divergence = [...viewMap.entries()]
      .map(([slug, totalViews]) => {
        const counts = voteMap.get(slug) ?? { up: 0, down: 0 };
        const totalVotes = counts.up + counts.down;
        return { slug, totalViews, totalVotes };
      })
      .filter((entry) => cardMap.has(entry.slug))
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
