import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbPublic } from "@/lib/db";
import { replacePostMentions, resolveSlashMentions } from "@/lib/profile/post-mentions";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const postId = Number.parseInt(id, 10);
  if (!Number.isFinite(postId)) {
    return NextResponse.json({ ok: false, error: "Invalid post id." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const nextText = typeof body.body === "string" ? body.body.trim() : "";
  if (!nextText) {
    return NextResponse.json({ ok: false, error: "Post cannot be empty." }, { status: 400 });
  }
  if (nextText.length > 280) {
    return NextResponse.json({ ok: false, error: "Post must be 280 characters or fewer." }, { status: 400 });
  }

  try {
    const db = dbPublic();
    const { data: existing, error: lookupError } = await db
      .from("profile_posts")
      .select("owner_id")
      .eq("id", postId)
      .maybeSingle<{ owner_id: string }>();

    if (lookupError) throw new Error(lookupError.message);
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Post not found." }, { status: 404 });
    }
    if (existing.owner_id !== auth.userId) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const { data: updated, error } = await db
      .from("profile_posts")
      .update({ body: nextText })
      .eq("id", postId)
      .eq("owner_id", auth.userId)
      .select("id, body, created_at")
      .single();

    if (error) throw new Error(error.message);
    const mentions = await resolveSlashMentions(db, nextText);
    await replacePostMentions(db, postId, mentions);
    const { data: mentionRows, error: mentionError } = await db
      .from("profile_post_card_mentions")
      .select("canonical_slug, mention_text, start_index, end_index")
      .eq("post_id", postId);

    if (mentionError) throw new Error(mentionError.message);

    return NextResponse.json({ ok: true, post: { ...updated, mentions: mentionRows ?? [] } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(_);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const postId = Number.parseInt(id, 10);
  if (!Number.isFinite(postId)) {
    return NextResponse.json({ ok: false, error: "Invalid post id." }, { status: 400 });
  }

  try {
    const db = dbPublic();
    const { data: existing, error: lookupError } = await db
      .from("profile_posts")
      .select("owner_id")
      .eq("id", postId)
      .maybeSingle<{ owner_id: string }>();

    if (lookupError) throw new Error(lookupError.message);
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Post not found." }, { status: 404 });
    }
    if (existing.owner_id !== auth.userId) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const { error } = await db
      .from("profile_posts")
      .delete()
      .eq("id", postId)
      .eq("owner_id", auth.userId);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
