"use client";

import { useEffect, useMemo, useState } from "react";

type Listing = {
  externalId: string;
  title: string;
  price: { value: string; currency: string } | null;
  shipping: { value: string; currency: string } | null;
  itemWebUrl: string;
  image: string | null;
  condition: string | null;
  endTime: string | null;
  seller: string | null;
};

type EbayListingsProps = {
  queryBase: string;
  cardVariantId: string | null;
};

function formatMoney(value: string, currency: string): string {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return `${value} ${currency}`;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function normalizeBrowseQuery(value: string, mode: "raw" | "psa"): string {
  const withoutNoise = value
    .replace(/\b(Unlimited|Common|Uncommon)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withGrade = mode === "psa" ? `${withoutNoise} PSA` : withoutNoise;
  return `${withGrade} -lot -proxy`.replace(/\s+/g, " ").trim();
}

export default function EbayListings({ queryBase, cardVariantId }: EbayListingsProps) {
  const [mode, setMode] = useState<"raw" | "psa">("raw");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Listing[]>([]);

  const query = useMemo(() => normalizeBrowseQuery(queryBase, mode), [mode, queryBase]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/ebay/browse?q=${encodeURIComponent(query)}&limit=12`);
        const payload = (await response.json()) as { ok: boolean; items?: Listing[]; error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "Could not load eBay listings.");
        }
        if (!cancelled) {
          const nextItems = payload.items ?? [];
          setItems(nextItems);
          if (cardVariantId && nextItems.length > 0) {
            // Background observation write; intentionally fire-and-forget.
            void fetch("/api/market/observe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                cardVariantId,
                listings: nextItems,
              }),
            }).catch(() => {});
          }
        }
      } catch (err) {
        if (!cancelled) {
          setItems([]);
          setError(String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [cardVariantId, query]);

  return (
    <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Live eBay listings</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${mode === "raw" ? "btn-accent" : "btn-ghost"}`}
          >
            Raw
          </button>
          <button
            type="button"
            onClick={() => setMode("psa")}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${mode === "psa" ? "btn-accent" : "btn-ghost"}`}
          >
            PSA
          </button>
        </div>
      </div>

      <p className="text-muted mt-2 text-xs">Query: {query}</p>

      {loading ? <p className="text-muted mt-3 text-sm">Loading listings...</p> : null}
      {!loading && error ? <p className="text-negative mt-3 text-sm">{error}</p> : null}
      {!loading && !error && items.length === 0 ? <p className="text-muted mt-3 text-sm">No live listings found.</p> : null}

      {!loading && !error && items.length > 0 ? (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.slice(0, 12).map((item, index) => (
            <li key={`${item.itemWebUrl}-${index}`} className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
              <div className="h-[120px] overflow-hidden rounded-[var(--radius-input)] border-app border bg-surface">
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="h-full w-full bg-surface-soft" />
                )}
              </div>
              <p
                className="text-app mt-2 text-sm font-semibold leading-tight"
                style={{
                  display: "-webkit-box",
                  overflow: "hidden",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {item.title}
              </p>
              <p className="text-app mt-2 text-sm font-semibold">
                {item.price ? formatMoney(item.price.value, item.price.currency) : "Price unavailable"}
              </p>
              <p className="text-muted mt-1 text-xs">
                Shipping: {item.shipping ? formatMoney(item.shipping.value, item.shipping.currency) : "—"}
              </p>
              <a
                href={item.itemWebUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost mt-2 inline-flex rounded-[var(--radius-input)] border px-2 py-1 text-xs font-semibold"
              >
                View on eBay
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
