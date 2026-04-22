import { notFound } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import { dbPublic } from "@/lib/db";
import FollowButton from "@/components/profile/follow-button";
import PostBody, { type PostMention } from "@/components/profile/post-body";

type PublicProfileRow = {
  handle: string;
  created_at: string;
  profile_bio: string | null;
  profile_banner_url: string | null;
};

type PublicStatsRow = {
  post_count: number;
  follower_count: number;
  following_count: number;
};

type PublicPostRow = {
  id: number;
  body: string;
  created_at: string;
  mentions?: PostMention[];
};

function formatJoined(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatPostTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export default async function PublicProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const normalized = handle.trim().toLowerCase();
  const db = dbPublic();

  const { data: profile } = await db
    .from("public_user_profiles")
    .select("handle, created_at, profile_bio, profile_banner_url")
    .eq("handle_norm", normalized)
    .maybeSingle<PublicProfileRow>();

  if (!profile) notFound();

  const [{ data: stats }, { data: posts }] = await Promise.all([
    db
      .from("public_profile_social_stats")
      .select("post_count, follower_count, following_count")
      .eq("handle", profile.handle)
      .maybeSingle<PublicStatsRow>(),
    db
      .from("public_profile_posts")
      .select("id, body, created_at")
      .eq("handle", profile.handle)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const social = stats ?? { post_count: 0, follower_count: 0, following_count: 0 };
  const profilePosts = (posts ?? []) as PublicPostRow[];
  const postIds = profilePosts.map((post) => post.id);
  const { data: mentionRows } = postIds.length > 0
    ? await db
        .from("public_profile_post_mentions")
        .select("post_id, canonical_slug, mention_text, start_index, end_index")
        .in("post_id", postIds)
        .order("start_index", { ascending: true })
    : { data: [] };

  const mentionsByPost = new Map<number, PostMention[]>();
  for (const row of ((mentionRows ?? []) as Array<Record<string, unknown>>)) {
    const postId = Number(row.post_id);
    const current = mentionsByPost.get(postId) ?? [];
    current.push({
      canonical_slug: String(row.canonical_slug),
      mention_text: String(row.mention_text),
      start_index: Number(row.start_index),
      end_index: Number(row.end_index),
    });
    mentionsByPost.set(postId, current);
  }

  const hydratedPosts = profilePosts.map((post) => ({
    ...post,
    mentions: mentionsByPost.get(post.id) ?? [],
  }));

  return (
    <PageShell>
      <div className="mx-auto max-w-3xl px-5 py-6 sm:px-8 sm:py-8">
        <section className="overflow-hidden rounded-[2rem] border border-[#1E1E1E] bg-[#101010]">
        <div
          className="h-40 bg-[radial-gradient(circle_at_top_left,rgba(29,78,216,0.24),transparent_34%),radial-gradient(circle_at_top_right,rgba(49,46,129,0.26),transparent_30%),linear-gradient(180deg,#0F172A_0%,#0A0A0A_72%)] bg-cover bg-center"
          style={profile.profile_banner_url ? { backgroundImage: `linear-gradient(180deg, rgba(10,10,10,0.18), rgba(10,10,10,0.68)), url("${profile.profile_banner_url}")` } : undefined}
        />

        <div className="px-5 pb-5 sm:px-6 sm:pb-6">
          <div className="-mt-16 flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-end gap-4">
              <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-[#101010] bg-white/[0.06] text-[32px] font-semibold text-white">
                {profile.handle.slice(0, 1).toUpperCase()}
              </div>
              <div className="pb-2">
                <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-white">@{profile.handle}</h1>
                <p className="text-[14px] text-[#8A8A8A]">Joined {formatJoined(profile.created_at)}</p>
              </div>
            </div>

            <FollowButton handle={profile.handle} initialFollowers={social.follower_count} />
          </div>

          <div className="mt-5">
            <p className="text-[15px] leading-7 text-[#D4D4D4]">
              {profile.profile_bio || "No bio yet."}
            </p>
            <div className="mt-4 flex flex-wrap gap-5 text-[13px] text-[#8A8A8A]">
              <span>{social.post_count} Posts</span>
              <span>{social.following_count} Following</span>
              <span>{social.follower_count} Followers</span>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-3 border-b border-[#1E1E1E]">
            <div className="border-b-2 border-white px-2 py-3 text-center text-[13px] font-semibold text-white">Posts</div>
            <div className="px-2 py-3 text-center text-[13px] font-semibold text-[#6B6B6B]">Collections</div>
            <div className="px-2 py-3 text-center text-[13px] font-semibold text-[#6B6B6B]">Replies</div>
          </div>

          <div className="px-1 py-6">
            {hydratedPosts.length === 0 ? (
              <div className="rounded-[1.5rem] border border-dashed border-[#1E1E1E] bg-[#0B0B0B] px-5 py-8 text-center">
                <p className="text-[18px] font-semibold tracking-[-0.03em] text-white">Nothing here yet</p>
                <p className="mt-2 text-[14px] leading-6 text-[#8A8A8A]">No posts from this profile yet.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {hydratedPosts.map((post) => (
                  <article key={post.id} className="rounded-[1.35rem] border border-[#1E1E1E] bg-[#0B0B0B] px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[14px] font-semibold text-white">@{profile.handle}</p>
                      <span className="text-[12px] text-[#6B6B6B]">{formatPostTime(post.created_at)}</span>
                    </div>
                    <PostBody body={post.body} mentions={post.mentions ?? []} />
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      </div>
    </PageShell>
  );
}
