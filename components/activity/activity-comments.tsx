"use client";

import { useState, useCallback } from "react";
import { MessageCircle, Send } from "lucide-react";
import type { ActivityComment } from "@/lib/activity/types";
import Link from "next/link";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export default function ActivityComments({
  eventId,
  initialCount,
}: {
  eventId: number;
  initialCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<ActivityComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [count, setCount] = useState(initialCount);

  const loadComments = useCallback(async () => {
    if (loaded) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/activity/comments?event_id=${eventId}`);
      const data = await res.json();
      if (data.ok) {
        setComments(data.comments);
        setLoaded(true);
      }
    } finally {
      setLoading(false);
    }
  }, [eventId, loaded]);

  const toggleOpen = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && !loaded) loadComments();
  }, [open, loaded, loadComments]);

  const submit = useCallback(async () => {
    const body = text.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/activity/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId, body }),
      });
      const data = await res.json();
      if (data.ok) {
        setComments((prev) => [
          ...prev,
          {
            id: data.id,
            author: { id: "", handle: "you" },
            body,
            created_at: data.created_at ?? new Date().toISOString(),
          },
        ]);
        setCount((prev) => prev + 1);
        setText("");
      }
    } finally {
      setSubmitting(false);
    }
  }, [eventId, text, submitting]);

  return (
    <div>
      <button
        type="button"
        onClick={toggleOpen}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-[#6B6B6B] transition-colors hover:bg-white/[0.06]"
      >
        <MessageCircle size={14} strokeWidth={2} />
        {count > 0 && <span>{count}</span>}
      </button>

      {open && (
        <div className="mt-3 space-y-2 border-t border-[#1E1E1E] pt-3">
          {loading && (
            <p className="text-[12px] text-[#6B6B6B]">Loading...</p>
          )}

          {comments.map((c) => (
            <div key={c.id} className="flex gap-2">
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-semibold text-white">
                {c.author.handle.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-[12px] leading-5">
                  <Link
                    href={`/u/${c.author.handle}`}
                    className="font-semibold text-white hover:underline"
                  >
                    @{c.author.handle}
                  </Link>{" "}
                  <span className="text-[#D4D4D4]">{c.body}</span>
                </p>
                <span className="text-[11px] text-[#6B6B6B]">{formatTime(c.created_at)}</span>
              </div>
            </div>
          ))}

          <div className="flex items-center gap-2 pt-1">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Add a comment..."
              maxLength={500}
              className="min-w-0 flex-1 rounded-lg border border-[#1E1E1E] bg-[#0A0A0A] px-3 py-1.5 text-[13px] text-white placeholder:text-[#6B6B6B] focus:border-[#00B4D8] focus:outline-none"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim() || submitting}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-[#00B4D8] text-white transition-opacity disabled:opacity-40"
            >
              <Send size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
