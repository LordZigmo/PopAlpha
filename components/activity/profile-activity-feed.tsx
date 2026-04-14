"use client";

import { useState, useEffect, useCallback } from "react";
import type { ActivityFeedItem } from "@/lib/activity/types";
import ActivityEventRow from "./activity-event-row";

export default function ProfileActivityFeed({ handle }: { handle: string }) {
  const [items, setItems] = useState<ActivityFeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/activity/profile?handle=${encodeURIComponent(handle)}&limit=10`);
      const data = await res.json();
      if (data.ok) setItems(data.items);
    } finally {
      setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-3 px-1 py-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse rounded-[1.35rem] border border-[#1E1E1E] bg-[#0B0B0B] p-4">
            <div className="flex gap-3">
              <div className="h-9 w-9 rounded-full bg-white/[0.06]" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-3/4 rounded bg-white/[0.06]" />
                <div className="h-3 w-1/2 rounded bg-white/[0.04]" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="px-1 py-6">
        <div className="rounded-[1.5rem] border border-dashed border-[#1E1E1E] bg-[#0B0B0B] px-5 py-8 text-center">
          <p className="text-[18px] font-semibold tracking-[-0.03em] text-white">No activity yet</p>
          <p className="mt-2 text-[14px] leading-6 text-[#8A8A8A]">
            This collector hasn't logged any activity yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-1 py-6">
      {items.map((item) => (
        <ActivityEventRow key={item.id} item={item} />
      ))}
    </div>
  );
}
