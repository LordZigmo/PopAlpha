"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell } from "lucide-react";
import Link from "next/link";
import type { NotificationItem } from "@/lib/activity/types";

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

function notificationText(n: NotificationItem): string {
  switch (n.type) {
    case "like":
      return `@${n.actor.handle} liked your activity`;
    case "comment":
      return `@${n.actor.handle} commented on your activity`;
    case "follow":
      return `@${n.actor.handle} started following you`;
    default:
      return `@${n.actor.handle} interacted with you`;
  }
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/activity/notifications?limit=15");
      const data = await res.json();
      if (data.ok) {
        setNotifications(data.notifications);
        setUnreadCount(data.unread_count);
        setLoaded(true);
      }
    } catch {
      // silent
    }
  }, []);

  // Load on mount (just unread count)
  useEffect(() => {
    load();
  }, [load]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const toggleOpen = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) {
      load();
      // Mark all as read
      if (unreadCount > 0) {
        fetch("/api/activity/notifications/read", { method: "POST" }).then(() => {
          setUnreadCount(0);
          setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
        }).catch(() => {});
      }
    }
  }, [open, load, unreadCount]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-[#1E1E1E] bg-[#111111] transition-colors hover:bg-white/[0.06]"
        aria-label="Notifications"
      >
        <Bell size={16} className="text-[#D4D4D4]" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FF3B30] px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-[#1E1E1E] bg-[#111111] shadow-[0_24px_48px_rgba(0,0,0,0.5)]">
          <div className="border-b border-[#1E1E1E] px-4 py-3">
            <p className="text-[14px] font-semibold text-white">Notifications</p>
          </div>

          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-[13px] text-[#6B6B6B]">No notifications yet</p>
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`flex items-start gap-3 border-b border-[#1E1E1E] px-4 py-3 last:border-b-0 ${!n.read ? "bg-[#00B4D8]/[0.04]" : ""}`}
                >
                  <Link href={`/u/${n.actor.handle}`} className="shrink-0">
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.06] text-[11px] font-semibold text-white">
                      {n.actor.handle.slice(0, 1).toUpperCase()}
                    </div>
                  </Link>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] leading-5 text-[#D4D4D4]">
                      {notificationText(n)}
                    </p>
                    <span className="text-[11px] text-[#6B6B6B]">{formatTime(n.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
