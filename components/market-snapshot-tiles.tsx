"use client";

import { useEffect, useState } from "react";
import { GroupCard, GroupedSection, Pill, Skeleton, StatRow, StatTile } from "@/components/ios-grouped-ui";

type SnapshotPayload = {
  ok: boolean;
  active7d?: number;
  median7d?: number | null;
  median30d?: number | null;
  trimmedMedian30d?: number | null;
  low30d?: number | null;
  high30d?: number | null;
};

type MarketSnapshotTilesProps = {
  slug: string;
  printingId: string | null;
  grade: string;
  initialData?: SnapshotPayload | null;
};

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Collecting";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Insufficient sample";
  const rounded = Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${rounded}%`;
}

function formatVelocity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "Forming";
  return `${value.toFixed(value >= 10 ? 0 : 1)}/day`;
}

function tileTone(value: number | null | undefined): "neutral" | "positive" | "negative" {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function changeMicrocopy(value: number | null): string {
  if (value === null) return "Insufficient sample";
  if (value === 0) return "Flat versus 30D";
  return value > 0 ? "Pricing firming" : "Pricing easing";
}

export default function MarketSnapshotTiles({ slug, printingId, grade, initialData = null }: MarketSnapshotTilesProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SnapshotPayload | null>(initialData);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ slug, grade });
        if (printingId) params.set("printing", printingId);
        const response = await fetch(`/api/market/snapshot?${params.toString()}`);
        const payload = (await response.json()) as SnapshotPayload;
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setData({ ok: false });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, printingId, grade]);

  const median7d = data?.median7d ?? null;
  const median30d = data?.median30d ?? null;
  const trimmedMedian30d = data?.trimmedMedian30d ?? null;
  const active7d = data?.active7d ?? 0;
  const changeBase = trimmedMedian30d ?? median30d;
  const changePct =
    median7d !== null &&
    changeBase !== null &&
    Number.isFinite(median7d) &&
    Number.isFinite(changeBase) &&
    changeBase > 0
      ? ((median7d - changeBase) / changeBase) * 100
      : null;
  const listingVelocity = active7d > 0 ? active7d / 7 : null;
  const spread30d =
    data?.high30d !== null &&
    data?.high30d !== undefined &&
    data?.low30d !== null &&
    data?.low30d !== undefined &&
    Number.isFinite(data.high30d) &&
    Number.isFinite(data.low30d)
      ? data.high30d - data.low30d
      : null;

  return (
    <GroupedSection title="Market Intelligence" description="Signal-first view of current ask depth and pricing pressure.">
      <GroupCard
        header={
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[15px] font-semibold text-[#f5f7fb]">Live signal dashboard</p>
              <p className="text-[12px] text-[#8c94a3]">Aligned metrics, clear states, no decorative noise.</p>
            </div>
            {loading ? <Pill label="Refreshing" tone="neutral" size="small" /> : null}
          </div>
        }
      >
        {!loading && data && !data.ok ? <p className="text-[14px] text-[#98a0ae]">Snapshot unavailable right now.</p> : null}

        {loading && !data ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <GroupCard key={index} inset>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-8 w-28" />
                <Skeleton className="mt-4 h-6 w-24" />
              </GroupCard>
            ))}
          </div>
        ) : null}

        {!loading && (!data || data.ok) ? (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <StatTile label="Median Ask (7D)" value={formatUsd(median7d)} detail={median7d === null ? "Collecting" : "Rolling 7-day median"} />
              <StatTile
                label="7D Change"
                value={formatPercent(changePct)}
                detail={changeMicrocopy(changePct)}
                tone={tileTone(changePct)}
              />
              <StatTile label="Trimmed Median (30D)" value={formatUsd(trimmedMedian30d)} detail={trimmedMedian30d === null ? "Collecting" : "Outliers trimmed"} />
            </div>
            <div className="mt-4 divide-y divide-white/[0.06] rounded-2xl border border-white/[0.06] bg-[#11151d] px-4">
              <StatRow label="Active Listings (7D)" value={active7d > 0 ? active7d : "Collecting"} meta={active7d > 0 ? "Observed live supply" : "Collecting"} />
              <StatRow label="Listing Velocity" value={formatVelocity(listingVelocity)} meta={listingVelocity === null ? "Forming" : "Observed per day"} />
              <StatRow label="High-Low Spread (30D)" value={formatUsd(spread30d)} meta={spread30d === null ? "Insufficient sample" : "Ask range"} />
            </div>
          </>
        ) : null}
      </GroupCard>
    </GroupedSection>
  );
}
