import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbPublic } from "@/lib/db";
import { ensureAppUser } from "@/lib/data/app-user";
import { replacePostMentions, resolveSlashMentions } from "@/lib/profile/post-mentions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const rawText = typeof body.body === "string" ? body.body.trim() : "";
  if (!rawText) {
    return NextResponse.json({ ok: false, error: "Post cannot be empty." }, { status: 400 });
  }

  if (rawText.length > 280) {
    return NextResponse.json({ ok: false, error: "Post must be 280 characters or fewer." }, { status: 400 });
  }

  try {
    await ensureAppUser(auth.userId);
    const db = dbPublic();
    const mentions = await resolveSlashMentions(db, rawText);
    const { data: post, error } = await db
      .from("profile_posts")
      .insert({
        owner_id: auth.userId,
        body: rawText,
      })
      .select("id, body, created_at")
      .single();

    if (error) throw new Error(error.message);
    await replacePostMentions(db, post.id as number, mentions);

    const { data: mentionRows, error: mentionError } = await db
      .from("profile_post_card_mentions")
      .select("canonical_slug, mention_text, start_index, end_index")
      .eq("post_id", post.id);

    if (mentionError) throw new Error(mentionError.message);

    return NextResponse.json({ ok: true, post: { ...post, mentions: mentionRows ?? [] } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
