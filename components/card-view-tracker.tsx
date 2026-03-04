"use client";

import { useEffect, useRef, useState } from "react";
import ViewHistoryChart from "@/components/view-history-chart";

type ViewHistoryPoint = {
  date: string;
  views: number;
};

type CardViewTrackerProps = {
  canonicalSlug: string;
  initialTotalViews: number;
  initialSeries: ViewHistoryPoint[];
  locked?: boolean;
};

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function incrementSeries(points: ViewHistoryPoint[]): ViewHistoryPoint[] {
  if (points.length === 0) return points;
  const today = todayUtcKey();
  let found = false;
  const next = points.map((point) => {
    if (point.date !== today) return point;
    found = true;
    return { ...point, views: point.views + 1 };
  });

  if (found) return next;

  return [
    ...next.slice(1),
    { date: today, views: 1 },
  ];
}

export default function CardViewTracker({
  canonicalSlug,
  initialTotalViews,
  initialSeries,
  locked = false,
}: CardViewTrackerProps) {
  const [totalViews, setTotalViews] = useState(initialTotalViews);
  const [series, setSeries] = useState(initialSeries);
  const trackedSlugRef = useRef<string | null>(null);

  useEffect(() => {
    setTotalViews(initialTotalViews);
    setSeries(initialSeries);
    trackedSlugRef.current = null;
  }, [canonicalSlug, initialSeries, initialTotalViews]);

  useEffect(() => {
    if (!canonicalSlug || trackedSlugRef.current === canonicalSlug) return;

    trackedSlugRef.current = canonicalSlug;
    let cancelled = false;

    void fetch(`/api/cards/${encodeURIComponent(canonicalSlug)}/view`, {
      method: "POST",
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok || cancelled) return;
        setTotalViews((current) => current + 1);
        setSeries((current) => incrementSeries(current));
      })
      .catch(() => {
        if (!cancelled) trackedSlugRef.current = null;
      });

    return () => {
      cancelled = true;
    };
  }, [canonicalSlug]);

  const recentViews = series.reduce((sum, point) => sum + point.views, 0);
  const todayViews = series[series.length - 1]?.views ?? 0;

  return (
    <section className="relative mb-6 overflow-hidden rounded-[24px] border border-[#1E1E1E] bg-[#101010] px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[#777]">View Activity</p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[34px] font-bold tracking-[-0.04em] text-[#F0F0F0] sm:text-[40px]">
              {formatCount(totalViews)}
            </span>
            <span className="text-[14px] text-[#6B6B6B]">total views</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 sm:gap-5">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#555]">Today</p>
            <p className="mt-1 text-[18px] font-semibold tabular-nums text-[#F0F0F0]">{formatCount(todayViews)}</p>
          </div>
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#555]">14D Views</p>
            <p className="mt-1 text-[18px] font-semibold tabular-nums text-[#F0F0F0]">{formatCount(recentViews)}</p>
          </div>
        </div>
      </div>

      <div className="mt-4">
        <ViewHistoryChart points={series} />
      </div>

      {locked ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#101010]/55 backdrop-blur-md">
          <div className="inline-flex items-center justify-center rounded-full border border-blue-400/20 bg-[linear-gradient(135deg,rgba(96,165,250,0.95),rgba(59,130,246,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(59,130,246,0.28)]">
            GET PREMIUM
          </div>
        </div>
      ) : null}
    </section>
  );
}
