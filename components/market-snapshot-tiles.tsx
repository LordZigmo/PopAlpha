"use client";

import { useEffect, useState } from "react";
import SignalBadge from "@/components/signal-badge";

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
  if (value === null || value === undefined || !Number.isFinite(value)) return "Collecting";
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

function Tile({
  label,
  value,
  microcopy,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  microcopy: string;
  tone?: "neutral" | "positive" | "negative";
}) {
  return (
    <div className="ui-card ui-card-standard">
      <p className="text-muted text-[11px] uppercase tracking-[0.08em]">{label}</p>
      <p className="text-app mt-2 text-xl font-semibold">{value}</p>
      <div className="mt-2">
        <SignalBadge
          label={microcopy}
          tone={tone === "neutral" ? "neutral" : tone === "positive" ? "positive" : "negative"}
        />
      </div>
    </div>
  );
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
    <section className="ui-card ui-card-panel mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Market Intelligence</p>
          <p className="text-muted mt-1 text-xs">Signal-first view of current ask depth and pricing pressure.</p>
        </div>
        {loading ? <SignalBadge label="Refreshing" tone="neutral" /> : null}
      </div>
      {!loading && data && !data.ok ? <p className="text-muted mt-3 text-sm">Snapshot unavailable right now.</p> : null}
      {!loading && (!data || data.ok) ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Tile label="Median Ask (7D)" value={formatUsd(median7d)} microcopy={median7d === null ? "Collecting data..." : "Rolling 7-day median"} />
          <Tile
            label="7D Change %"
            value={formatPercent(changePct)}
            microcopy={changePct === null ? "Insufficient sample" : changePct === 0 ? "Flat versus 30D" : changePct > 0 ? "Pricing firming" : "Pricing easing"}
            tone={tileTone(changePct)}
          />
          <Tile
            label="Trimmed Median (30D)"
            value={formatUsd(trimmedMedian30d)}
            microcopy={trimmedMedian30d === null ? "Waiting for observations" : "Outliers trimmed"}
          />
          <Tile
            label="Active Listings (7D)"
            value={active7d > 0 ? active7d : "Collecting"}
            microcopy={active7d > 0 ? "Observed live supply" : "Waiting for observations"}
          />
          <Tile
            label="30D Listing Velocity"
            value={formatVelocity(listingVelocity)}
            microcopy={listingVelocity === null ? "Signal forming..." : "Observed listings per day"}
          />
          <Tile
            label="High-Low Spread (30D)"
            value={formatUsd(spread30d)}
            microcopy={spread30d === null ? "Insufficient sample" : "Ask range across 30D"}
          />
        </div>
      ) : null}
    </section>
  );
}
