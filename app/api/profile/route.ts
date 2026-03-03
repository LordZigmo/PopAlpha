import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbPublic } from "@/lib/db";
import { ensureAppUser, updateAppProfile } from "@/lib/data/app-user";
import { validateHandle } from "@/lib/handles";

export const runtime = "nodejs";

function toProfilePayload(user: Awaited<ReturnType<typeof ensureAppUser>>) {
  return {
    clerk_user_id: user.clerk_user_id,
    handle: user.handle,
    onboarded: !!user.onboarding_completed_at,
    created_at: user.created_at,
    profile_bio: user.profile_bio,
    profile_banner_url: user.profile_banner_url,
  };
}

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const user = await ensureAppUser(auth.userId);
    const db = dbPublic();
    const { data: posts, error } = await db
      .from("profile_posts")
      .select("id, body, created_at")
      .eq("owner_id", auth.userId)
      .order("created_at", { ascending: false })
      .limit(25);

    const { data: stats, error: statsError } = await db
      .from("public_profile_social_stats")
      .select("post_count, follower_count, following_count")
      .eq("clerk_user_id", auth.userId)
      .maybeSingle<{ post_count: number; follower_count: number; following_count: number }>();

    if (error) throw new Error(error.message);
    if (statsError) throw new Error(statsError.message);

    const postIds = (posts ?? []).map((post) => post.id);
    const { data: mentions, error: mentionsError } = postIds.length > 0
      ? await db
          .from("profile_post_card_mentions")
          .select("post_id, canonical_slug, mention_text, start_index, end_index")
          .in("post_id", postIds)
          .order("start_index", { ascending: true })
      : { data: [], error: null };

    if (mentionsError) throw new Error(mentionsError.message);

    const mentionsByPost = new Map<number, Array<Record<string, unknown>>>();
    for (const mention of (mentions ?? []) as Array<Record<string, unknown>>) {
      const postId = Number(mention.post_id);
      const current = mentionsByPost.get(postId) ?? [];
      current.push(mention);
      mentionsByPost.set(postId, current);
    }

    const hydratedPosts = (posts ?? []).map((post) => ({
      ...post,
      mentions: mentionsByPost.get(post.id as number) ?? [],
    }));

    return NextResponse.json({
      ok: true,
      profile: toProfilePayload(user),
      posts: hydratedPosts,
      stats: stats ?? { post_count: 0, follower_count: 0, following_count: 0 },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  await ensureAppUser(auth.userId);

  const rawHandle = typeof body.handle === "string" ? body.handle : "";
  const bio = typeof body.profileBio === "string" ? body.profileBio.trim() : "";
  const nextBio = bio ? bio.slice(0, 280) : null;
  let handle: string | undefined;
  let handleNorm: string | undefined;

  if (rawHandle.trim()) {
    const result = validateHandle(rawHandle);
    if (!result.valid) {
      return NextResponse.json({ ok: false, error: result.reason }, { status: 400 });
    }
    handle = rawHandle.trim();
    handleNorm = result.normalized;
  }

  try {
    const updated = await updateAppProfile(auth.userId, {
      handle,
      handleNorm,
      profileBio: nextBio,
    });

    if (!updated) {
      return NextResponse.json({ ok: false, error: "That handle is already taken." }, { status: 409 });
    }

    return NextResponse.json({ ok: true, profile: toProfilePayload(updated) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
