import { NextResponse } from "next/server";

import { resolveAuthContext } from "@/lib/auth/context";
import { dbPublic } from "@/lib/db";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import { resolveCardImage } from "@/lib/images/resolve";

/**
 * GET /api/homepage/community — community rail for the homepage.
 *
 * Returns three sections:
 *   - trending:     cards with the most public activity events in the last 7 days
 *   - most_saved:   cards wishlisted by the most collectors in the last 7 days
 *   - friends_added: (auth-only) recent card additions from users you follow
 *
 * The first two use public aggregate views (no auth required, works for
 * logged-out users). The third is populated only for authenticated users
 * who follow at least one person.
 *
 * Cached at the CDN layer via Cache-Control: s-maxage=60, stale-while-revalidate=300.
 * Force dynamic so the build doesn't try to pre-render (which would require
 * NEXT_PUBLIC_SUPABASE_* at build time and break on env config drift).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CommunityCard = {
  slug: string;
  name: string;
  set_name: string | null;
  year: number | null;
  image_url: string | null;
  image_thumb_url: string | null;
  metric_value: number;
  metric_label: string;
};

type FriendEvent = {
  handle: string;
  action: string;
  card_name: string | null;
  canonical_slug: string | null;
  created_at: string;
};

const TRENDING_LIMIT = 8;
const MOST_SAVED_LIMIT = 5;
const FRIENDS_LIMIT = 5;

export async function GET(req: Request) {
  const publicDb = dbPublic();

  try {
    // ── Public aggregates (no auth needed) ──────────────────────────────
    const [trendingResult, savedResult] = await Promise.all([
      publicDb
        .from("public_community_trending_7d")
        .select("canonical_slug, event_count, unique_actors")
        .limit(TRENDING_LIMIT),
      publicDb
        .from("public_community_most_saved_7d")
        .select("canonical_slug, save_count")
        .limit(MOST_SAVED_LIMIT),
    ]);

    if (trendingResult.error) {
      console.error("[homepage/community] trending", trendingResult.error.message);
    }
    if (savedResult.error) {
      console.error("[homepage/community] saved", savedResult.error.message);
    }

    const trendingRows = (trendingResult.data ?? []) as Array<{
      canonical_slug: string;
      event_count: number;
      unique_actors: number;
    }>;
    const savedRows = (savedResult.data ?? []) as Array<{
      canonical_slug: string;
      save_count: number;
    }>;

    // Collect all slugs for hydration.
    const allSlugs = new Set<string>();
    for (const r of trendingRows) allSlugs.add(r.canonical_slug);
    for (const r of savedRows) allSlugs.add(r.canonical_slug);

    // ── Friends added (auth-only, best-effort) ──────────────────────────
    let friendEvents: FriendEvent[] = [];
    try {
      const ctx = await resolveAuthContext(req);
      if (ctx.kind === "user") {
        const userDb = await createServerSupabaseUserClient();

        const { data: followRows } = await userDb
          .from("profile_follows")
          .select("followee_id")
          .eq("follower_id", ctx.userId);

        const followedIds = (followRows ?? []).map(
          (r: { followee_id: string }) => r.followee_id,
        );

        if (followedIds.length > 0) {
          const { data: events } = await userDb
            .from("activity_events")
            .select("actor_id, event_type, canonical_slug, created_at")
            .in("actor_id", followedIds)
            .in("event_type", ["collection.card_added", "wishlist.card_added"])
            .not("canonical_slug", "is", null)
            .order("created_at", { ascending: false })
            .limit(FRIENDS_LIMIT);

          const friendSlugs = (events ?? [])
            .map((e: { canonical_slug: string | null }) => e.canonical_slug)
            .filter((s: string | null): s is string => !!s);
          for (const s of friendSlugs) allSlugs.add(s);

          // Get handles for the actors
          const actorIds = [
            ...new Set(
              (events ?? []).map((e: { actor_id: string }) => e.actor_id),
            ),
          ];
          const { data: actors } = actorIds.length > 0
            ? await userDb
                .from("app_users")
                .select("clerk_user_id, handle")
                .in("clerk_user_id", actorIds)
            : { data: [] };

          const handleMap = new Map<string, string>();
          for (const a of (actors ?? []) as Array<{
            clerk_user_id: string;
            handle: string;
          }>) {
            handleMap.set(a.clerk_user_id, a.handle);
          }

          // We need card names — will hydrate below with the shared batch.
          // Store raw events for now, hydrate after.
          friendEvents = (events ?? []).map(
            (e: {
              actor_id: string;
              event_type: string;
              canonical_slug: string | null;
              created_at: string;
            }) => ({
              handle: handleMap.get(e.actor_id) ?? "collector",
              action:
                e.event_type === "wishlist.card_added"
                  ? "saved"
                  : "added",
              card_name: null, // hydrated below
              canonical_slug: e.canonical_slug,
              created_at: e.created_at,
            }),
          );
        }
      }
    } catch {
      // Auth or friends query failed — just return empty friends_added.
    }

    // ── Hydrate card metadata ───────────────────────────────────────────
    const slugArray = [...allSlugs];

    const [cardsResult, imagesResult] = await Promise.all([
      slugArray.length > 0
        ? publicDb
            .from("canonical_cards")
            .select("slug, canonical_name, set_name, year")
            .in("slug", slugArray)
            .eq("is_digital", false)
        : Promise.resolve({ data: [], error: null }),
      slugArray.length > 0
        ? publicDb
            .from("card_printings")
            .select("canonical_slug, image_url, mirrored_image_url, mirrored_thumb_url")
            .in("canonical_slug", slugArray)
            .eq("language", "EN")
            .not("image_url", "is", null)
            .limit(slugArray.length)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const cardMap = new Map<
      string,
      { canonical_name: string; set_name: string | null; year: number | null }
    >();
    for (const c of (cardsResult.data ?? []) as Array<{
      slug: string;
      canonical_name: string;
      set_name: string | null;
      year: number | null;
    }>) {
      cardMap.set(c.slug, c);
    }

    const imageMap = new Map<string, { full: string | null; thumb: string | null }>();
    for (const img of (imagesResult.data ?? []) as Array<{
      canonical_slug: string;
      image_url: string | null;
      mirrored_image_url: string | null;
      mirrored_thumb_url: string | null;
    }>) {
      if (imageMap.has(img.canonical_slug)) continue;
      const resolved = resolveCardImage(img);
      if (resolved.full || resolved.thumb) {
        imageMap.set(img.canonical_slug, resolved);
      }
    }

    // ── Assemble response ───────────────────────────────────────────────
    const trending: CommunityCard[] = trendingRows.map((r) => {
      const card = cardMap.get(r.canonical_slug);
      return {
        slug: r.canonical_slug,
        name: card?.canonical_name ?? r.canonical_slug,
        set_name: card?.set_name ?? null,
        year: card?.year ?? null,
        image_url: imageMap.get(r.canonical_slug)?.full ?? null,
        image_thumb_url: imageMap.get(r.canonical_slug)?.thumb ?? null,
        metric_value: r.unique_actors,
        metric_label: `${r.unique_actors} collectors`,
      };
    });

    const mostSaved: CommunityCard[] = savedRows.map((r) => {
      const card = cardMap.get(r.canonical_slug);
      return {
        slug: r.canonical_slug,
        name: card?.canonical_name ?? r.canonical_slug,
        set_name: card?.set_name ?? null,
        year: card?.year ?? null,
        image_url: imageMap.get(r.canonical_slug)?.full ?? null,
        image_thumb_url: imageMap.get(r.canonical_slug)?.thumb ?? null,
        metric_value: r.save_count,
        metric_label: `${r.save_count} saves`,
      };
    });

    // Hydrate friend events with card names.
    const friendsAdded: FriendEvent[] = friendEvents.map((f) => ({
      ...f,
      card_name: f.canonical_slug
        ? (cardMap.get(f.canonical_slug)?.canonical_name ?? f.canonical_slug)
        : null,
    }));

    return NextResponse.json(
      {
        ok: true,
        trending,
        most_saved: mostSaved,
        friends_added: friendsAdded,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[homepage/community] failed:", message);
    return NextResponse.json(
      { ok: false, error: "Internal error." },
      { status: 500 },
    );
  }
}
