import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbPublic } from "@/lib/db";
import { ensureAppUser } from "@/lib/data/app-user";
import { getCommunityVoteWeekEndMs, getCommunityVoteWeekStart, type CommunityVoteSide } from "@/lib/data/community-pulse";

export const runtime = "nodejs";

const WEEKLY_VOTE_LIMIT = 10;

type VoteRow = {
  vote_side: CommunityVoteSide;
};

type FeedEventRow = {
  voter_id: string;
  canonical_slug: string;
  vote_side: CommunityVoteSide;
  created_at: string;
  canonical_name: string | null;
  set_name: string | null;
};

type FollowRow = {
  followee_id: string;
};

type UserVoteWeekRow = {
  votes_used: number;
  votes_remaining: number;
};

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    await ensureAppUser(auth.userId);
    const db = dbPublic();
    const weekStart = getCommunityVoteWeekStart();

    const [{ data: weeklyUsage, error: weeklyError }, { data: followees, error: followError }] = await Promise.all([
      db
        .from("community_user_vote_weeks")
        .select("votes_used, votes_remaining")
        .eq("voter_id", auth.userId)
        .eq("week_start", weekStart)
        .maybeSingle<UserVoteWeekRow>(),
      db
        .from("profile_follows")
        .select("followee_id")
        .eq("follower_id", auth.userId),
    ]);

    if (weeklyError) throw new Error(weeklyError.message);
    if (followError) throw new Error(followError.message);

    const followeeIds = ((followees ?? []) as FollowRow[]).map((row) => row.followee_id).filter(Boolean);

    let followedVotes: FeedEventRow[] = [];
    if (followeeIds.length > 0) {
      const { data, error } = await db
        .from("community_vote_feed_events")
        .select("voter_id, canonical_slug, vote_side, created_at, canonical_name, set_name")
        .eq("week_start", weekStart)
        .in("voter_id", followeeIds)
        .order("created_at", { ascending: false })
        .limit(8);

      if (error) throw new Error(error.message);
      followedVotes = (data ?? []) as FeedEventRow[];
    }

    return NextResponse.json({
      ok: true,
      weekStart,
      weekEndsAt: getCommunityVoteWeekEndMs(),
      votesUsed: weeklyUsage?.votes_used ?? 0,
      votesRemaining: weeklyUsage?.votes_remaining ?? WEEKLY_VOTE_LIMIT,
      followedVotes: followedVotes.map((row) => ({
        voterId: row.voter_id,
        canonicalSlug: row.canonical_slug,
        vote: row.vote_side,
        createdAt: row.created_at,
        cardName: row.canonical_name,
        setName: row.set_name,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const canonicalSlug = typeof body.canonicalSlug === "string" ? body.canonicalSlug.trim() : "";
  const direction = body.direction === "up" || body.direction === "down"
    ? (body.direction as CommunityVoteSide)
    : null;

  if (!canonicalSlug) {
    return NextResponse.json({ ok: false, error: "Missing card." }, { status: 400 });
  }

  if (!direction) {
    return NextResponse.json({ ok: false, error: "Missing direction." }, { status: 400 });
  }

  try {
    await ensureAppUser(auth.userId);
    const db = dbPublic();
    const weekStart = getCommunityVoteWeekStart();

    const [{ data: existingVote, error: existingError }, { data: weeklyUsage, error: countError }] = await Promise.all([
      db
        .from("community_card_votes")
        .select("vote_side")
        .eq("voter_id", auth.userId)
        .eq("canonical_slug", canonicalSlug)
        .eq("week_start", weekStart)
        .maybeSingle<VoteRow>(),
      db
        .from("community_user_vote_weeks")
        .select("votes_used, votes_remaining")
        .eq("voter_id", auth.userId)
        .eq("week_start", weekStart),
    ]);

    if (existingError) throw new Error(existingError.message);
    if (countError) throw new Error(countError.message);

    if (existingVote) {
      return NextResponse.json(
        { ok: false, error: "You already voted on this card this week." },
        { status: 409 },
      );
    }

    const usageRow = Array.isArray(weeklyUsage)
      ? (weeklyUsage[0] as UserVoteWeekRow | undefined)
      : (weeklyUsage as UserVoteWeekRow | null);
    const votesUsed = usageRow?.votes_used ?? 0;
    if (votesUsed >= WEEKLY_VOTE_LIMIT) {
      return NextResponse.json(
        { ok: false, error: "You have used all 10 weekly votes." },
        { status: 409 },
      );
    }

    const { error: insertError } = await db.from("community_card_votes").insert({
      voter_id: auth.userId,
      canonical_slug: canonicalSlug,
      vote_side: direction,
      week_start: weekStart,
    });

    if (insertError) throw new Error(insertError.message);

    const { data: slugVotes, error: tallyError } = await db
      .from("community_card_votes")
      .select("vote_side")
      .eq("canonical_slug", canonicalSlug)
      .eq("week_start", weekStart);

    if (tallyError) throw new Error(tallyError.message);

    let bullishVotes = 0;
    let bearishVotes = 0;
    for (const row of (slugVotes ?? []) as VoteRow[]) {
      if (row.vote_side === "up") bullishVotes += 1;
      else bearishVotes += 1;
    }

    return NextResponse.json({
      ok: true,
      vote: direction,
      bullishVotes,
      bearishVotes,
      votesRemaining: Math.max(0, (usageRow?.votes_remaining ?? WEEKLY_VOTE_LIMIT) - 1),
      weekEndsAt: getCommunityVoteWeekEndMs(),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
