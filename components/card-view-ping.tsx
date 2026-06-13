"use client";

/**
 * Headless card-view tracker. Records a view via POST /api/cards/[slug]/view
 * on mount (once per slug) and renders nothing. The visual "View Activity"
 * chart was dropped for iOS parity, but the view-count side effect must stay —
 * it feeds getCardViewSnapshot / the context-rail "Views" and popularity data.
 * iOS likewise tracks card views without surfacing the bar chart.
 */
import { useEffect, useRef } from "react";

export default function CardViewPing({ canonicalSlug }: { canonicalSlug: string }) {
  const trackedSlugRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canonicalSlug || trackedSlugRef.current === canonicalSlug) return;
    trackedSlugRef.current = canonicalSlug;
    let cancelled = false;

    void fetch(`/api/cards/${encodeURIComponent(canonicalSlug)}/view`, {
      method: "POST",
      cache: "no-store",
    }).catch(() => {
      // Best-effort; allow a retry on a later mount if the ping failed.
      if (!cancelled) trackedSlugRef.current = null;
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalSlug]);

  return null;
}
