"use client";

/**
 * Friend Activity — parity with the native iOS section. Fetches the existing
 * auth-gated route GET /api/activity/card?slug=, then renders owner count +
 * up to 3 recent followed-user events. Renders nothing on the server / first
 * client paint and self-hides when the viewer is signed out or there's no
 * activity (so no hydration-time text mismatch and no empty shell).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { GroupedSection, GroupCard } from "@/components/ios-grouped-ui";
import type { CardFriendActivity, ActivityFeedItem } from "@/lib/activity/types";

function relTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  const minutes = Math.max(1, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function actionText(item: ActivityFeedItem): string {
  switch (item.event_type) {
    case "collection.card_added":
      return "added this to their collection";
    case "wishlist.card_added":
      return "added this to their wishlist";
    default:
      return "is tracking this card";
  }
}

export default function FriendActivitySection({
  canonicalSlug,
  isSignedIn,
}: {
  canonicalSlug: string;
  isSignedIn: boolean;
}) {
  // Cache the result keyed by the slug it belongs to, so a previous card's
  // activity is never shown for the current card during in-app /c/[slug]
  // navigation (the response is guarded at render time, below).
  const [fetched, setFetched] = useState<{ slug: string; data: CardFriendActivity } | null>(null);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    void fetch(`/api/activity/card?slug=${encodeURIComponent(canonicalSlug)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled) return;
        setFetched(payload && payload.ok ? { slug: canonicalSlug, data: payload as CardFriendActivity } : null);
      })
      .catch(() => {
        // best-effort; stay hidden on failure
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canonicalSlug, isSignedIn]);

  // Only trust data that belongs to the slug being rendered right now — until
  // the new fetch resolves, a stale previous-card result reads as absent.
  const data = fetched && fetched.slug === canonicalSlug ? fetched.data : null;

  if (!isSignedIn || !data) return null;
  const recent = data.recent.slice(0, 3);
  if (data.owner_count <= 0 && recent.length === 0) return null;

  return (
    <GroupedSection title="Friend Activity">
      <GroupCard>
        {data.owner_count > 0 ? (
          <p className="text-[15px] text-[#D0D0D0]">
            <span className="font-semibold text-[#F0F0F0]">{data.owner_count}</span>{" "}
            {data.owner_count === 1 ? "friend owns" : "friends own"} this card
          </p>
        ) : null}
        {recent.length > 0 ? (
          <div className={data.owner_count > 0 ? "mt-3 space-y-2.5 border-t border-white/[0.06] pt-3" : "space-y-2.5"}>
            {recent.map((item, index) => (
              <div key={`${item.actor.handle}-${item.created_at}-${index}`} className="flex items-center justify-between gap-3 text-[14px]">
                <p className="min-w-0 truncate text-[#999]">
                  <Link href={`/u/${item.actor.handle}`} className="font-semibold text-white hover:underline">
                    @{item.actor.handle}
                  </Link>{" "}
                  {actionText(item)}
                </p>
                <span className="shrink-0 tabular-nums text-[#6B6B6B]">{relTime(item.created_at)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </GroupCard>
    </GroupedSection>
  );
}
