"use client";

import Link from "next/link";
import Image from "next/image";
import type { ActivityFeedItem } from "@/lib/activity/types";
import ActivityLikeButton from "./activity-like-button";
import ActivityComments from "./activity-comments";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function buildActionText(item: ActivityFeedItem): React.ReactNode {
  switch (item.event_type) {
    case "collection.card_added":
      return (
        <>
          added{" "}
          {item.canonical_slug ? (
            <Link href={`/c/${item.canonical_slug}`} className="font-semibold text-white hover:underline">
              {item.card_name ?? item.canonical_slug}
            </Link>
          ) : (
            <span className="font-semibold text-white">{item.card_name ?? "a card"}</span>
          )}{" "}
          to their collection
        </>
      );
    case "wishlist.card_added":
      return (
        <>
          added{" "}
          {item.canonical_slug ? (
            <Link href={`/c/${item.canonical_slug}`} className="font-semibold text-white hover:underline">
              {item.card_name ?? item.canonical_slug}
            </Link>
          ) : (
            <span className="font-semibold text-white">{item.card_name ?? "a card"}</span>
          )}{" "}
          to their wishlist
        </>
      );
    case "social.followed_user":
      return (
        <>
          followed{" "}
          {item.target_user ? (
            <Link href={`/u/${item.target_user.handle}`} className="font-semibold text-white hover:underline">
              @{item.target_user.handle}
            </Link>
          ) : (
            <span className="font-semibold text-white">a collector</span>
          )}
        </>
      );
    case "milestone.set_progress":
      return (
        <>
          reached{" "}
          <span className="font-semibold text-[#00DC5A]">
            {(item.metadata.percent as number | undefined) ?? "?"}%
          </span>{" "}
          completion on{" "}
          <span className="font-semibold text-white">{item.set_name ?? "a set"}</span>
        </>
      );
    case "milestone.collection_value":
      return (
        <>
          hit{" "}
          <span className="font-semibold text-[#FFD700]">
            ${(item.metadata.value as number | undefined)?.toLocaleString() ?? "?"}
          </span>{" "}
          collection value
        </>
      );
    case "collection.grade_upgraded":
      return (
        <>
          upgraded{" "}
          {item.canonical_slug ? (
            <Link href={`/c/${item.canonical_slug}`} className="font-semibold text-white hover:underline">
              {item.card_name ?? item.canonical_slug}
            </Link>
          ) : (
            <span className="font-semibold text-white">{item.card_name ?? "a card"}</span>
          )}{" "}
          to <span className="font-semibold text-[#00B4D8]">{(item.metadata.new_grade as string) ?? "graded"}</span>
        </>
      );
    default:
      return "did something";
  }
}

export default function ActivityEventRow({ item }: { item: ActivityFeedItem }) {
  const showCardImage = item.card_image_url && (
    item.event_type === "collection.card_added" ||
    item.event_type === "wishlist.card_added" ||
    item.event_type === "collection.grade_upgraded"
  );

  return (
    <article className="rounded-[1.35rem] border border-[#1E1E1E] bg-[#0B0B0B] p-4">
      <div className="flex gap-3">
        {/* Avatar */}
        <Link href={`/u/${item.actor.handle}`} className="shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-[14px] font-semibold text-white">
            {item.actor.avatar_initial}
          </div>
        </Link>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] leading-6 text-[#D4D4D4]">
            <Link href={`/u/${item.actor.handle}`} className="font-semibold text-white hover:underline">
              @{item.actor.handle}
            </Link>{" "}
            {buildActionText(item)}
          </p>

          {/* Card thumbnail */}
          {showCardImage && (
            <Link href={`/c/${item.canonical_slug}`} className="mt-2.5 block">
              <div className="relative inline-block overflow-hidden rounded-xl border border-[#1E1E1E]">
                <Image
                  src={item.card_image_url!}
                  alt={item.card_name ?? "Card"}
                  width={80}
                  height={112}
                  className="object-cover"
                />
              </div>
              {item.set_name && (
                <p className="mt-1 text-[11px] text-[#6B6B6B]">{item.set_name}</p>
              )}
            </Link>
          )}

          {/* Footer: timestamp + actions */}
          <div className="mt-2 flex items-center gap-3">
            <span className="text-[12px] text-[#6B6B6B]">{formatTime(item.created_at)}</span>
            <ActivityLikeButton
              eventId={item.id}
              initialLiked={item.liked_by_me}
              initialCount={item.like_count}
            />
            <ActivityComments
              eventId={item.id}
              initialCount={item.comment_count}
            />
          </div>
        </div>
      </div>
    </article>
  );
}
