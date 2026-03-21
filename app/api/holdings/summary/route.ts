import { NextResponse } from "next/server";
import { requireOnboarded } from "@/lib/auth/require";
import { getCommunityVoteWeekStart } from "@/lib/data/community-pulse";
import { createServerSupabaseUserClient } from "@/lib/db/user";

export const runtime = "nodejs";

type HoldingRow = {
  canonical_slug: string | null;
  qty: number | null;
  created_at: string;
};

type CardMetaRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
};

type PrintingRow = {
  canonical_slug: string;
  image_url: string | null;
};

type MetricRow = {
  canonical_slug: string;
  market_price: number | null;
  change_pct_7d: number | null;
};

type HotMoverRow = {
  canonical_slug: string;
};

type CommunityVoteRow = {
  canonical_slug: string;
  vote_side: "up" | "down";
};

type CommunityVoteTotalsRow = {
  canonical_slug: string;
  bullish_votes: number;
  bearish_votes: number;
};

export async function GET(req: Request) {
  const auth = await requireOnboarded(req);
  if (!auth.ok) return auth.response;

  try {
    const supabase = await createServerSupabaseUserClient();
    const { data: holdingsData, error: holdingsError } = await supabase
      .from("holdings")
      .select("canonical_slug, qty, created_at")
      .eq("owner_clerk_id", auth.userId)
      .not("canonical_slug", "is", null)
      .order("created_at", { ascending: false })
      .limit(120);

    if (holdingsError) {
      throw new Error(holdingsError.message);
    }

    const holdings = (holdingsData ?? []) as HoldingRow[];
    const uniqueSlugs = [...new Set(holdings.map((row) => row.canonical_slug).filter(Boolean))] as string[];

    if (uniqueSlugs.length === 0) {
      return NextResponse.json({
        ok: true,
        collectionValue: 0,
        accuracyScore: null,
        setCompletion: null,
        watchlist: [],
      });
    }

    const { data: cardData, error: cardError } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name")
      .in("slug", uniqueSlugs);

    if (cardError) throw new Error(cardError.message);

    const { data: imageData, error: imageError } = await supabase
      .from("card_printings")
      .select("canonical_slug, image_url")
      .in("canonical_slug", uniqueSlugs)
      .not("image_url", "is", null)
      .limit(uniqueSlugs.length * 3);

    if (imageError) throw new Error(imageError.message);

    const { data: metricData, error: metricError } = await supabase
      .from("public_card_metrics")
      .select("canonical_slug, market_price, change_pct_7d")
      .in("canonical_slug", uniqueSlugs)
      .eq("grade", "RAW");

    if (metricError) throw new Error(metricError.message);

    const { data: hotMoverData, error: hotMoverError } = await supabase
      .from("public_variant_movers_priced")
      .select("canonical_slug")
      .in("canonical_slug", uniqueSlugs)
      .eq("provider", "JUSTTCG")
      .eq("grade", "RAW")
      .eq("mover_tier", "hot");

    if (hotMoverError) throw new Error(hotMoverError.message);

    const cardMap = new Map<string, CardMetaRow>();
    for (const row of (cardData ?? []) as CardMetaRow[]) {
      cardMap.set(row.slug, row);
    }

    const imageMap = new Map<string, string>();
    for (const row of (imageData ?? []) as PrintingRow[]) {
      if (row.canonical_slug && row.image_url && !imageMap.has(row.canonical_slug)) {
        imageMap.set(row.canonical_slug, row.image_url);
      }
    }

    const changeMap = new Map<string, number>();
    const marketPriceMap = new Map<string, number>();
    for (const row of (metricData ?? []) as MetricRow[]) {
      if (row.canonical_slug && row.market_price != null && !marketPriceMap.has(row.canonical_slug)) {
        marketPriceMap.set(row.canonical_slug, row.market_price);
      }
      if (!row.canonical_slug || row.change_pct_7d == null || changeMap.has(row.canonical_slug)) continue;
      changeMap.set(row.canonical_slug, row.change_pct_7d);
    }
    const hotSlugSet = new Set(
      ((hotMoverData ?? []) as HotMoverRow[]).map((row) => row.canonical_slug).filter(Boolean),
    );

    const weekStart = getCommunityVoteWeekStart();
    const { data: myVotes, error: myVotesError } = await supabase
      .from("community_card_votes")
      .select("canonical_slug, vote_side")
      .eq("voter_id", auth.userId)
      .eq("week_start", weekStart);

    if (myVotesError) throw new Error(myVotesError.message);

    const votedSlugs = [...new Set(((myVotes ?? []) as CommunityVoteRow[]).map((row) => row.canonical_slug).filter(Boolean))];
    let accuracyScore: number | null = null;
    if (votedSlugs.length > 0) {
      const { data: voteTotals, error: allVotesError } = await supabase
        .from("public_community_vote_totals")
        .select("canonical_slug, bullish_votes, bearish_votes")
        .eq("week_start", weekStart)
        .in("canonical_slug", votedSlugs);

      if (allVotesError) throw new Error(allVotesError.message);

      const voteTallies = new Map<string, { up: number; down: number }>();
      for (const row of (voteTotals ?? []) as CommunityVoteTotalsRow[]) {
        voteTallies.set(row.canonical_slug, {
          up: row.bullish_votes ?? 0,
          down: row.bearish_votes ?? 0,
        });
      }

      let score = 0;
      let total = 0;
      for (const row of (myVotes ?? []) as CommunityVoteRow[]) {
        const bucket = voteTallies.get(row.canonical_slug);
        if (!bucket) continue;
        total += 1;
        if (bucket.up === bucket.down) {
          score += 0.5;
        } else {
          const majority = bucket.up > bucket.down ? "up" : "down";
          if (row.vote_side === majority) score += 1;
        }
      }
      accuracyScore = total > 0 ? Math.round((score / total) * 100) : null;
    }

    let collectionValue = 0;
    for (const row of holdings) {
      const slug = row.canonical_slug;
      if (!slug) continue;
      const marketPrice = marketPriceMap.get(slug);
      if (marketPrice == null) continue;
      collectionValue += marketPrice * (row.qty ?? 0);
    }

    const heldSetMap = new Map<string, Set<string>>();
    for (const slug of uniqueSlugs) {
      const setName = cardMap.get(slug)?.set_name?.trim();
      if (!setName) continue;
      const bucket = heldSetMap.get(setName) ?? new Set<string>();
      bucket.add(slug);
      heldSetMap.set(setName, bucket);
    }

    let setCompletion: {
      setName: string;
      ownedCount: number;
      totalCount: number;
      percent: number;
    } | null = null;

    if (heldSetMap.size > 0) {
      const [focusSetName, ownedSet] = [...heldSetMap.entries()].sort((a, b) => b[1].size - a[1].size)[0]!;
      const { count } = await supabase
        .from("canonical_cards")
        .select("slug", { count: "exact", head: true })
        .eq("set_name", focusSetName);

      const totalCount = count ?? 0;
      const ownedCount = ownedSet.size;
      setCompletion = {
        setName: focusSetName,
        ownedCount,
        totalCount,
        percent: totalCount > 0 ? Math.round((ownedCount / totalCount) * 100) : 0,
      };
    }

    const watchlist = [...uniqueSlugs]
      .sort((a, b) => {
        const absA = Math.abs(changeMap.get(a) ?? 0);
        const absB = Math.abs(changeMap.get(b) ?? 0);
        if (absB !== absA) return absB - absA;
        return 0;
      })
      .slice(0, 5)
      .map((slug) => ({
      slug,
      name: cardMap.get(slug)?.canonical_name ?? slug,
      setName: cardMap.get(slug)?.set_name ?? null,
      imageUrl: imageMap.get(slug) ?? null,
      currentPrice: marketPriceMap.get(slug) ?? null,
      isHotMover: hotSlugSet.has(slug),
      }));

    return NextResponse.json({
      ok: true,
      collectionValue,
      accuracyScore,
      setCompletion,
      watchlist,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
