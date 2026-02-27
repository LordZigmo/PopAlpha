"use client";

import { useEffect, useState } from "react";
import { watchlistCount } from "@/lib/watchlist";

export default function WatchlistCountBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const refresh = () => setCount(watchlistCount());
    refresh();
    window.addEventListener("watchlist:changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("watchlist:changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return (
    <span className="rounded-full border border-app bg-surface-soft px-2 py-1 text-[11px] text-muted">
      Watchlist {count}
    </span>
  );
}
