import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";

export const runtime = "nodejs";

export type WishlistRow = {
  id: number;
  canonical_slug: string;
  note: string | null;
  created_at: string;
  // Hydrated fields (joined)
  canonical_name?: string;
  set_name?: string | null;
  year?: number | null;
  image_url?: string | null;
};

// ── GET /api/wishlist — list the authenticated user's wishlist ───────────────

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const db = await createServerSupabaseUserClient();

  const { data: items, error } = await db
    .from("wishlist_items")
    .select("id, canonical_slug, note, created_at")
    .eq("owner_id", auth.userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[wishlist GET]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const rows = items ?? [];

  // Hydrate card metadata
  const slugs = rows.map((r: { canonical_slug: string }) => r.canonical_slug);

  if (slugs.length === 0) {
    return NextResponse.json({ ok: true, items: [] });
  }

  const slugFilter = `(${slugs.join(",")})`;

  const [cardsRes, imagesRes] = await Promise.all([
    db
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year")
      .in("slug", slugs),
    db
      .from("card_printings")
      .select("canonical_slug, image_url")
      .in("canonical_slug", slugs)
      .eq("language", "EN")
      .not("image_url", "is", null)
      .limit(slugs.length),
  ]);

  const cardMap = new Map<string, { canonical_name: string; set_name: string | null; year: number | null }>();
  for (const c of (cardsRes.data ?? []) as { slug: string; canonical_name: string; set_name: string | null; year: number | null }[]) {
    cardMap.set(c.slug, c);
  }

  const imageMap = new Map<string, string>();
  for (const img of (imagesRes.data ?? []) as { canonical_slug: string; image_url: string | null }[]) {
    if (img.image_url && !imageMap.has(img.canonical_slug)) {
      imageMap.set(img.canonical_slug, img.image_url);
    }
  }

  const hydrated: WishlistRow[] = rows.map((r: { id: number; canonical_slug: string; note: string | null; created_at: string }) => {
    const card = cardMap.get(r.canonical_slug);
    return {
      ...r,
      canonical_name: card?.canonical_name ?? r.canonical_slug,
      set_name: card?.set_name ?? null,
      year: card?.year ?? null,
      image_url: imageMap.get(r.canonical_slug) ?? null,
    };
  });

  return NextResponse.json({ ok: true, items: hydrated });
}

// ── POST /api/wishlist — add a card to the wishlist ─────────────────────────

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const canonical_slug = typeof body.canonical_slug === "string" ? body.canonical_slug.trim() : "";
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  if (!canonical_slug) {
    return NextResponse.json({ ok: false, error: "canonical_slug is required." }, { status: 400 });
  }

  const db = await createServerSupabaseUserClient();

  const { error } = await db
    .from("wishlist_items")
    .upsert(
      {
        owner_id: auth.userId,
        canonical_slug,
        note,
      },
      { onConflict: "owner_id,canonical_slug" },
    );

  if (error) {
    console.error("[wishlist POST]", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  // Emit activity event (fire-and-forget)
  import("@/lib/activity/emit").then(async ({ emitActivityEvent }) => {
    let cardName = canonical_slug;
    try {
      const { data: card } = await db
        .from("canonical_cards")
        .select("canonical_name")
        .eq("slug", canonical_slug)
        .maybeSingle();
      if (card?.canonical_name) cardName = card.canonical_name;
    } catch {}
    emitActivityEvent({
      actorId: auth.userId,
      eventType: "wishlist.card_added",
      canonicalSlug: canonical_slug,
      metadata: { card_name: cardName },
    });
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}

// ── DELETE /api/wishlist?slug= — remove a card from the wishlist ────────────

export async function DELETE(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) {
    return NextResponse.json({ ok: false, error: "slug is required." }, { status: 400 });
  }

  const db = await createServerSupabaseUserClient();

  const { error } = await db
    .from("wishlist_items")
    .delete()
    .eq("owner_id", auth.userId)
    .eq("canonical_slug", slug);

  if (error) {
    console.error("[wishlist DELETE]", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
