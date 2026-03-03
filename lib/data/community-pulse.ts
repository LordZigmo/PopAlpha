import { dbPublic } from "@/lib/db";
import type { HomepageCard } from "@/lib/data/homepage";

export type CommunityVoteSide = "up" | "down";

export type CommunityPulseCard = {
  slug: string;
  name: string;
  setName: string | null;
  imageUrl: string | null;
  changePct: number | null;
  bullishVotes: number;
  bearishVotes: number;
  userVote: CommunityVoteSide | null;
  followedUpCount: number;
  followedDownCount: number;
};

export type CommunityPulseSnapshot = {
  cards: CommunityPulseCard[];
  votesRemaining: number;
  weeklyLimit: number;
  weekEndsAt: number;
};

const WEEKLY_VOTE_LIMIT = 10;
const BOARD_CARD_LIMIT = 4;

type VoteRow = {
  canonical_slug: string;
  vote_side: CommunityVoteSide;
  voter_id: string;
};

type FollowRow = {
  followee_id: string;
};

export function getCommunityVoteWeekStart(date = new Date()): string {
  const value = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const mondayOffset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - mondayOffset);
  return value.toISOString().slice(0, 10);
}

export function getCommunityVoteWeekEndMs(date = new Date()): number {
  const value = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const mondayOffset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - mondayOffset + 7);
  value.setUTCHours(0, 0, 0, 0);
  return value.getTime();
}

function pickPulseCandidates(cards: HomepageCard[]): HomepageCard[] {
  const seen = new Set<string>();
  const picked: HomepageCard[] = [];

  for (const card of cards) {
    if (!card?.slug || seen.has(card.slug)) continue;
    seen.add(card.slug);
    picked.push(card);
    if (picked.length >= BOARD_CARD_LIMIT) break;
  }

  return picked;
}

export async function getCommunityPulseSnapshot(
  candidates: HomepageCard[],
  userId: string | null,
): Promise<CommunityPulseSnapshot> {
  const selectedCards = pickPulseCandidates(candidates);
  const slugs = selectedCards.map((card) => card.slug);
  const weekStart = getCommunityVoteWeekStart();
  const weekEndsAt = getCommunityVoteWeekEndMs();

  if (slugs.length === 0) {
    return {
      cards: [],
      votesRemaining: WEEKLY_VOTE_LIMIT,
      weeklyLimit: WEEKLY_VOTE_LIMIT,
      weekEndsAt,
    };
  }

  const db = dbPublic();

  const [voteResult, userVotesResult, followeesResult] = await Promise.all([
    db
      .from("community_card_votes")
      .select("canonical_slug, vote_side, voter_id")
      .eq("week_start", weekStart)
      .in("canonical_slug", slugs),
    userId
      ? db
          .from("community_card_votes")
          .select("canonical_slug")
          .eq("week_start", weekStart)
          .eq("voter_id", userId)
      : Promise.resolve({ data: [] as Array<{ canonical_slug: string }>, error: null }),
    userId
      ? db
          .from("profile_follows")
          .select("followee_id")
          .eq("follower_id", userId)
      : Promise.resolve({ data: [] as FollowRow[], error: null }),
  ]);

  if (voteResult.error) console.error("[community-pulse] votes", voteResult.error.message);
  if (userVotesResult.error) console.error("[community-pulse] user votes", userVotesResult.error.message);
  if (followeesResult.error) console.error("[community-pulse] followees", followeesResult.error.message);

  const voteRows = (voteResult.data ?? []) as VoteRow[];
  const followeeIds = new Set(
    ((followeesResult.data ?? []) as FollowRow[]).map((row) => row.followee_id).filter(Boolean),
  );

  const userVotesUsed = userId
    ? Math.min(WEEKLY_VOTE_LIMIT, ((userVotesResult.data ?? []) as Array<{ canonical_slug: string }>).length)
    : 0;

  const counts = new Map<string, {
    up: number;
    down: number;
    userVote: CommunityVoteSide | null;
    followedUpCount: number;
    followedDownCount: number;
  }>();

  for (const slug of slugs) {
    counts.set(slug, {
      up: 0,
      down: 0,
      userVote: null,
      followedUpCount: 0,
      followedDownCount: 0,
    });
  }

  for (const row of voteRows) {
    const bucket = counts.get(row.canonical_slug);
    if (!bucket) continue;

    if (row.vote_side === "up") bucket.up += 1;
    else bucket.down += 1;

    if (userId && row.voter_id === userId) {
      bucket.userVote = row.vote_side;
    }

    if (followeeIds.has(row.voter_id)) {
      if (row.vote_side === "up") bucket.followedUpCount += 1;
      else bucket.followedDownCount += 1;
    }
  }

  return {
    cards: selectedCards.map((card) => {
      const bucket = counts.get(card.slug);
      return {
        slug: card.slug,
        name: card.name,
        setName: card.set_name ?? null,
        imageUrl: card.image_url ?? null,
        changePct: card.change_pct ?? null,
        bullishVotes: bucket?.up ?? 0,
        bearishVotes: bucket?.down ?? 0,
        userVote: bucket?.userVote ?? null,
        followedUpCount: bucket?.followedUpCount ?? 0,
        followedDownCount: bucket?.followedDownCount ?? 0,
      };
    }),
    votesRemaining: Math.max(0, WEEKLY_VOTE_LIMIT - userVotesUsed),
    weeklyLimit: WEEKLY_VOTE_LIMIT,
    weekEndsAt,
  };
}
