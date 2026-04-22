"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Activity, Users } from "lucide-react";
import type { ActivityFeedItem } from "@/lib/activity/types";
import ActivityEventRow from "@/components/activity/activity-event-row";
import NotificationBell from "@/components/activity/notification-bell";
import PageShell from "@/components/layout/PageShell";

function SkeletonRow() {
  return (
    <div className="animate-pulse rounded-[1.35rem] border border-[#1E1E1E] bg-[#0B0B0B] p-4">
      <div className="flex gap-3">
        <div className="h-9 w-9 rounded-full bg-white/[0.06]" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-3/4 rounded bg-white/[0.06]" />
          <div className="h-3 w-1/2 rounded bg-white/[0.04]" />
        </div>
      </div>
    </div>
  );
}

export default function ActivityPage() {
  const [items, setItems] = useState<ActivityFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const observerRef = useRef<HTMLDivElement>(null);

  const fetchFeed = useCallback(async (cursorParam?: number | null) => {
    const isInitial = cursorParam === undefined || cursorParam === null;
    if (isInitial) setLoading(true);
    else setLoadingMore(true);

    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cursorParam) params.set("cursor", String(cursorParam));

      const res = await fetch(`/api/activity/feed?${params}`);
      const data = await res.json();

      if (!data.ok) {
        setError(data.error ?? "Failed to load feed.");
        return;
      }

      setItems((prev) => isInitial ? data.items : [...prev, ...data.items]);
      setCursor(data.next_cursor);
      setHasMore(data.next_cursor !== null);
      setError(null);
    } catch {
      setError("Failed to load feed.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchFeed();
  }, [fetchFeed]);

  // Infinite scroll
  useEffect(() => {
    if (!hasMore || loadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && cursor) {
          fetchFeed(cursor);
        }
      },
      { threshold: 0.1 },
    );
    const el = observerRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [cursor, hasMore, loadingMore, fetchFeed]);

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl px-5 py-6 sm:px-8 sm:py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-white">Activity</h1>
            <p className="mt-1 text-[14px] text-[#8A8A8A]">See what collectors you follow are up to</p>
          </div>
          <NotificationBell />
        </div>

      {/* Feed */}
      {loading ? (
        <div className="space-y-3">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : error ? (
        <div className="rounded-[1.5rem] border border-dashed border-[#1E1E1E] bg-[#0B0B0B] px-5 py-12 text-center">
          <p className="text-[15px] text-[#FF3B30]">{error}</p>
          <button
            type="button"
            onClick={() => fetchFeed()}
            className="mt-3 rounded-full bg-white/[0.06] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-white/[0.1]"
          >
            Try again
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-[#1E1E1E] bg-[#0B0B0B] px-5 py-16 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.04]">
            <Users className="text-[#6B6B6B]" size={24} />
          </div>
          <p className="text-[18px] font-semibold tracking-[-0.03em] text-white">Your feed is quiet</p>
          <p className="mx-auto mt-2 max-w-xs text-[14px] leading-6 text-[#8A8A8A]">
            Follow collectors to see their pickups, milestones, and collection activity here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ActivityEventRow key={item.id} item={item} />
          ))}

          {/* Infinite scroll trigger */}
          <div ref={observerRef} className="h-4" />

          {loadingMore && (
            <div className="flex justify-center py-4">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#00B4D8] border-t-transparent" />
            </div>
          )}

            {!hasMore && items.length > 5 && (
              <p className="py-6 text-center text-[13px] text-[#6B6B6B]">You're all caught up</p>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}
