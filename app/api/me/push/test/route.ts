import { NextResponse } from "next/server";
import type { PushSubscription } from "web-push";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { sendWebPush } from "@/lib/push/web-push";

export const runtime = "nodejs";

type SubscriptionRow = {
  endpoint: string;
  subscription: PushSubscription;
};

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const db = dbAdmin();
    const { data, error } = await db
      .from("push_subscriptions")
      .select("endpoint, subscription")
      .eq("clerk_user_id", auth.userId)
      .eq("enabled", true);

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as SubscriptionRow[];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "No active push subscriptions found." }, { status: 400 });
    }

    let delivered = 0;
    for (const row of rows) {
      try {
        await sendWebPush(row.subscription, {
          title: "PopAlpha Alerts",
          body: "Push notifications are live on this device.",
          url: "/settings",
          tag: "popalpha-push-test",
        });
        delivered += 1;
      } catch (error) {
        const statusCode =
          typeof error === "object" &&
          error &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : null;

        if (statusCode === 404 || statusCode === 410) {
          await db.from("push_subscriptions").delete().eq("endpoint", row.endpoint).eq("clerk_user_id", auth.userId);
          continue;
        }

        throw error;
      }
    }

    return NextResponse.json({ ok: true, delivered });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
