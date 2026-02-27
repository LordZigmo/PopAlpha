"use client";

import { useEffect, useState } from "react";

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
};

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
      <p className="text-muted text-[11px] uppercase tracking-[0.08em]">{label}</p>
      <p className="text-app mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

export default function MarketSnapshotTiles({ slug, printingId, grade }: MarketSnapshotTilesProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SnapshotPayload | null>(null);

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

  return (
    <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
      <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Market Snapshot</p>
      {loading ? <p className="text-muted mt-2 text-sm">Loading snapshot...</p> : null}
      {!loading && data && !data.ok ? <p className="text-muted mt-2 text-sm">Snapshot unavailable.</p> : null}
      {!loading && (!data || data.ok) ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Tile label="Median Ask (7d)" value={formatUsd(data?.median7d)} />
          <Tile label="Median Ask (30d)" value={formatUsd(data?.median30d)} />
          <Tile label="Trimmed Median (30d)" value={formatUsd(data?.trimmedMedian30d)} />
          <Tile label="Active Listings (7d)" value={data?.active7d ?? 0} />
          <Tile label="Low Ask (30d)" value={formatUsd(data?.low30d)} />
          <Tile label="High Ask (30d)" value={formatUsd(data?.high30d)} />
        </div>
      ) : null}
    </section>
  );
}
