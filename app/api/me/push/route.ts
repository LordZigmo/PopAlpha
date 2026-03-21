import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import { isWebPushConfigured } from "@/lib/push/web-push";

export const runtime = "nodejs";

type StoredSubscription = {
  endpoint: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
};

function normalizePlatform(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().slice(0, 40);
  return value || null;
}

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const db = await createServerSupabaseUserClient();
    const { count, error } = await db
      .from("push_subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("clerk_user_id", auth.userId)
      .eq("enabled", true);

    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      configured: isWebPushConfigured(),
      hasSubscription: (count ?? 0) > 0,
      subscriptionCount: count ?? 0,
      vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null,
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

  const subscription = body.subscription as StoredSubscription | undefined;
  if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint.trim()) {
    return NextResponse.json({ ok: false, error: "A valid push subscription is required." }, { status: 400 });
  }

  try {
    const db = await createServerSupabaseUserClient();
    const now = new Date().toISOString();
    const { error } = await db.from("push_subscriptions").upsert(
      {
        clerk_user_id: auth.userId,
        endpoint: subscription.endpoint,
        subscription,
        enabled: true,
        user_agent: req.headers.get("user-agent"),
        platform: normalizePlatform(body.platform),
        updated_at: now,
        last_seen_at: now,
      },
      { onConflict: "endpoint" },
    );

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) {
    return NextResponse.json({ ok: false, error: "Subscription endpoint is required." }, { status: 400 });
  }

  try {
    const db = await createServerSupabaseUserClient();
    const { error } = await db
      .from("push_subscriptions")
      .delete()
      .eq("clerk_user_id", auth.userId)
      .eq("endpoint", endpoint);

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
