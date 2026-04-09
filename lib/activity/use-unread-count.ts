"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Hook to poll unread notification count. Returns { unreadCount, refresh }.
 * Polls every 60 seconds while mounted. Lightweight — only fetches the count.
 */
export function useUnreadNotificationCount() {
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/activity/notifications?limit=1");
      const data = await res.json();
      if (data.ok) setUnreadCount(data.unread_count ?? 0);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { unreadCount, refresh };
}
