import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { dbPublic } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/portfolio/activity
 *
 * Returns recent portfolio activity: cards added in the last 30 days,
 * enriched with card names and formatted as a timeline.
 */

type HoldingRow = {
  canonical_slug: string;
  grade: string;
  qty: number;
  created_at: string;
};

type CardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
};

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const admin = dbAdmin();
    const pub = dbPublic();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const { data: holdingsData, error: holdingsErr } = await admin
      .from("holdings")
      .select("canonical_slug, grade, qty, created_at")
      .eq("owner_clerk_id", auth.userId)
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: false })
      .limit(10);

    if (holdingsErr) throw new Error(holdingsErr.message);
    const recent = (holdingsData ?? []) as HoldingRow[];

    if (recent.length === 0) {
      return NextResponse.json({ ok: true, activities: [] });
    }

    const slugs = [...new Set(recent.map((h) => h.canonical_slug).filter(Boolean))];
    const { data: cardsData } = await pub
      .from("canonical_cards")
      .select("slug, canonical_name, set_name")
      .in("slug", slugs);

    const cardMap = new Map<string, CardRow>();
    for (const c of (cardsData ?? []) as CardRow[]) {
      cardMap.set(c.slug, c);
    }

    const activities = recent.map((h) => {
      const card = cardMap.get(h.canonical_slug);
      const name = card?.canonical_name ?? h.canonical_slug;
      const set = card?.set_name ?? "";
      const gradeLabel = h.grade === "RAW" ? "Raw" : h.grade;
      const ago = relativeTime(h.created_at);

      return {
        title: `Added ${name}`,
        description: set ? `${set} ${gradeLabel}` : gradeLabel,
        time_ago: ago,
        icon: "plus.circle",
      };
    });

    return NextResponse.json({ ok: true, activities });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[portfolio/activity] failed:", message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins <= 1 ? "Just now" : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}
