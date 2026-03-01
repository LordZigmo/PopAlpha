"use client";

import { useEffect, useState } from "react";
import { GroupCard, GroupedSection, Pill, Skeleton, StatRow } from "@/components/ios-grouped-ui";
import PriceTickerStrip from "@/components/price-ticker-strip";
import CollapsibleSection from "@/components/collapsible-section";

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
  derivedSignals?: {
    trend: { label: string; score: number } | null;
    breakout: { label: string; score: number } | null;
    value: { label: string; score: number } | null;
  } | null;
  signalsMeta?: {
    historyPoints30d: number | null;
    signalsAsOfTs: string | null;
  } | null;
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

export default function MarketSnapshotTiles({
  slug,
  printingId,
  grade,
  initialData = null,
}: MarketSnapshotTilesProps) {
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
    <GroupedSection>
      <GroupCard
        header={
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px] font-semibold text-[#F0F0F0]">Market Intelligence</p>
            {loading ? <Pill label="Refreshing" tone="neutral" size="small" /> : null}
          </div>
        }
      >
        {!loading && data && !data.ok ? <p className="text-[14px] text-[#777]">Snapshot unavailable right now.</p> : null}

        {loading && !data ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" rounded="card" />
            <Skeleton className="h-16 w-full" rounded="card" />
          </div>
        ) : null}

        {!loading && (!data || data.ok) ? (
          <>
            {median7d === null && changePct === null && trimmedMedian30d === null ? (
              <p className="text-[14px] text-[#777]">Pricing data forming.</p>
            ) : (
              <PriceTickerStrip
                items={[
                  ...(median7d !== null ? [{ label: "Median Ask (7D)", value: formatUsd(median7d) }] : []),
                  ...(changePct !== null ? [{ label: "7D Change", value: formatPercent(changePct), tone: tileTone(changePct) as "neutral" | "positive" | "negative" }] : []),
                  ...(trimmedMedian30d !== null ? [{ label: "Trimmed Med (30D)", value: formatUsd(trimmedMedian30d) }] : []),
                ]}
              />
            )}
            {(active7d > 0 || listingVelocity !== null || spread30d !== null) && (
              <CollapsibleSection title="Market Depth" defaultOpen={false}>
                <div className="divide-y divide-[#1E1E1E] rounded-2xl border border-[#1E1E1E] bg-[#111111] px-4">
                  {active7d > 0 && (
                    <StatRow label="Active Listings (7D)" value={active7d} meta="Observed live supply" />
                  )}
                  {listingVelocity !== null && (
                    <StatRow label="Listing Velocity" value={formatVelocity(listingVelocity)} meta="Observed per day" />
                  )}
                  {spread30d !== null && (
                    <StatRow label="High-Low Spread (30D)" value={formatUsd(spread30d)} meta="Ask range" />
                  )}
                </div>
              </CollapsibleSection>
            )}
          </>
        ) : null}
      </GroupCard>
    </GroupedSection>
  );
}
