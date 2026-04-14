"use client";

import { useState, useCallback } from "react";
import { Heart } from "lucide-react";

export default function ActivityLikeButton({
  eventId,
  initialLiked,
  initialCount,
}: {
  eventId: number;
  initialLiked: boolean;
  initialCount: number;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [pending, setPending] = useState(false);

  const toggle = useCallback(async () => {
    if (pending) return;
    // Optimistic update
    setLiked((prev) => !prev);
    setCount((prev) => prev + (liked ? -1 : 1));
    setPending(true);

    try {
      const res = await fetch("/api/activity/like", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId }),
      });
      const data = await res.json();
      if (data.ok) {
        setLiked(data.liked);
        setCount(data.like_count);
      }
    } catch {
      // Revert on error
      setLiked((prev) => !prev);
      setCount((prev) => prev + (liked ? 1 : -1));
    } finally {
      setPending(false);
    }
  }, [eventId, liked, pending]);

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-white/[0.06]"
    >
      <Heart
        size={14}
        strokeWidth={2}
        className={liked ? "fill-[#FF3B30] text-[#FF3B30]" : "text-[#6B6B6B]"}
      />
      {count > 0 && (
        <span className={liked ? "text-[#FF3B30]" : "text-[#6B6B6B]"}>{count}</span>
      )}
    </button>
  );
}
