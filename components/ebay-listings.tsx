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
  query: string;
  canonicalSlug: string;
  printingId: string | null;
  grade: "RAW" | "PSA9" | "PSA10";
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

function normalizeBrowseQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export default function EbayListings({ query, canonicalSlug, printingId, grade }: EbayListingsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Listing[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [showQuery, setShowQuery] = useState(false);

  const normalizedQuery = useMemo(() => normalizeBrowseQuery(query), [query]);
  const shownItems = expanded ? items.slice(0, 12) : items.slice(0, 6);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setExpanded(false);
      try {
        const response = await fetch(`/api/ebay/browse?q=${encodeURIComponent(normalizedQuery)}&limit=12`);
        const payload = (await response.json()) as { ok: boolean; items?: Listing[]; error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "Could not load eBay listings.");
        }
        if (!cancelled) {
          const nextItems = payload.items ?? [];
          setItems(nextItems);
          if (nextItems.length > 0) {
            void fetch("/api/market/observe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                canonicalSlug,
                printingId,
                grade,
                source: "EBAY",
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
  }, [canonicalSlug, printingId, grade, normalizedQuery]);

  return (
    <section className="mt-8 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Live Market Listings</p>
          <p className="text-muted mt-1 text-xs">Live eBay asks are evidence, not the core signal.</p>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 ? (
            <a
              href={`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(normalizedQuery)}`}
              target="_blank"
              rel="noreferrer"
              className="text-muted text-xs underline underline-offset-4"
            >
              View all on eBay
            </a>
          ) : null}
          {items.length > 6 ? (
            <button type="button" onClick={() => setExpanded((value) => !value)} className="btn-ghost rounded-[var(--radius-input)] border px-2.5 py-1 text-xs font-semibold">
              {expanded ? "Show less" : "View all"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-2">
        <button type="button" onClick={() => setShowQuery((value) => !value)} className="text-muted text-[11px] underline underline-offset-4">
          {showQuery ? "Hide query used" : "Query used"}
        </button>
        {showQuery ? <p className="text-muted mt-1 text-[11px]">{normalizedQuery}</p> : null}
      </div>

      {loading ? <p className="text-muted mt-3 text-sm">Loading listings...</p> : null}
      {!loading && error ? <p className="text-muted mt-3 text-sm">Listings unavailable right now.</p> : null}
      {!loading && !error && items.length === 0 ? <p className="text-muted mt-3 text-sm">No live listings yet. PopAlpha will surface evidence as the market forms.</p> : null}

      {!loading && !error && shownItems.length > 0 ? (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shownItems.map((item, index) => (
            <li key={`${item.externalId || item.itemWebUrl}-${index}`} className="rounded-[var(--radius-card)] border-app border bg-surface-soft/45 p-2.5">
              <div className="flex items-start gap-2">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[var(--radius-input)] border-app border bg-surface">
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="h-full w-full bg-surface-soft" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-app truncate text-xs font-semibold">{item.title}</p>
                  <p className="text-muted mt-1 truncate text-xs">
                    {item.price ? formatMoney(item.price.value, item.price.currency) : "Price unavailable"}
                    {" • "}
                    {item.shipping ? formatMoney(item.shipping.value, item.shipping.currency) : "Shipping —"}
                  </p>
                  <p className="text-muted mt-1 truncate text-[11px]">
                    {item.condition ?? "Condition n/a"}
                    {item.endTime ? ` • Ends ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.endTime))}` : ""}
                  </p>
                  <a
                    href={item.itemWebUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-ghost mt-1.5 inline-flex rounded-[var(--radius-input)] border px-2 py-0.5 text-[11px] font-semibold"
                  >
                    View on eBay
                  </a>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
