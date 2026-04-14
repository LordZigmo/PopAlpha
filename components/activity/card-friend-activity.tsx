"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import type { CardFriendActivity } from "@/lib/activity/types";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export default function CardFriendActivityModule({ slug }: { slug: string }) {
  const [data, setData] = useState<CardFriendActivity | null>(null);

  useEffect(() => {
    fetch(`/api/activity/card?slug=${encodeURIComponent(slug)}`)
      .then((res) => res.json())
      .then((res) => {
        if (res.ok) setData(res);
      })
      .catch(() => {});
  }, [slug]);

  // Don't render if no data or no activity
  if (!data || (data.owner_count === 0 && data.recent.length === 0)) return null;

  return (
    <section className="rounded-[var(--radius-panel)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">
        <Users size={14} />
        Friend Activity
      </div>

      {data.owner_count > 0 && (
        <p className="mt-3 text-[14px] text-[#D4D4D4]">
          <span className="font-semibold text-white">{data.owner_count}</span>{" "}
          {data.owner_count === 1 ? "collector" : "collectors"} you follow {data.owner_count === 1 ? "owns" : "own"} this card
        </p>
      )}

      {data.recent.length > 0 && (
        <div className="mt-3 space-y-2">
          {data.recent.map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-[13px]">
              <Link href={`/u/${item.actor.handle}`} className="shrink-0">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-semibold text-white">
                  {item.actor.avatar_initial}
                </div>
              </Link>
              <p className="min-w-0 flex-1 truncate text-[#D4D4D4]">
                <Link href={`/u/${item.actor.handle}`} className="font-semibold text-white hover:underline">
                  @{item.actor.handle}
                </Link>{" "}
                {item.event_type === "collection.card_added" ? "added this" : "interacted"}
              </p>
              <span className="shrink-0 text-[11px] text-[#6B6B6B]">{formatTime(item.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
