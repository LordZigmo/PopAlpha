"use client";

import { useEffect, useState } from "react";

type SnapshotPayload = {
  ok: boolean;
  activeListings?: number;
  median7d?: number | null;
  median30d?: number | null;
  trimmedMedian30d?: number | null;
  error?: string;
};

type MarketSnapshotBoxProps = {
  cardVariantId: string | null;
};

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export default function MarketSnapshotBox({ cardVariantId }: MarketSnapshotBoxProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SnapshotPayload | null>(null);

  useEffect(() => {
    if (!cardVariantId) {
      setData(null);
      return;
    }
    const variantId = cardVariantId;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(`/api/market/snapshot?cardVariantId=${encodeURIComponent(variantId)}`);
        const payload = (await response.json()) as SnapshotPayload;
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setData({ ok: false, error: "Could not load market snapshot." });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [cardVariantId]);

  return (
    <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
      <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Market Snapshot</p>

      {!cardVariantId ? <p className="text-muted mt-2 text-sm">No variant selected.</p> : null}
      {cardVariantId && loading ? <p className="text-muted mt-2 text-sm">Loading snapshot...</p> : null}
      {cardVariantId && !loading && data && !data.ok ? (
        <p className="text-muted mt-2 text-sm">Snapshot unavailable.</p>
      ) : null}

      {cardVariantId && !loading && data?.ok ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
            <p className="text-muted text-xs">Active Listings (7d)</p>
            <p className="text-app mt-1 text-lg font-semibold">{data.activeListings ?? 0}</p>
          </div>
          <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
            <p className="text-muted text-xs">Median (7d)</p>
            <p className="text-app mt-1 text-lg font-semibold">{formatUsd(data.median7d ?? null)}</p>
          </div>
          <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
            <p className="text-muted text-xs">Median (30d)</p>
            <p className="text-app mt-1 text-lg font-semibold">{formatUsd(data.median30d ?? null)}</p>
          </div>
          <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
            <p className="text-muted text-xs">Trimmed Median (30d)</p>
            <p className="text-app mt-1 text-lg font-semibold">{formatUsd(data.trimmedMedian30d ?? null)}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
