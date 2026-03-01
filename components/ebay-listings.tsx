"use client";

import { useEffect, useState } from "react";
import { GroupCard, GroupedSection, Pill, Skeleton } from "@/components/ios-grouped-ui";

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
  const [showQuery, setShowQuery] = useState(false);

  const normalizedQuery = normalizeBrowseQuery(query);
  const shownItems = items.slice(0, 10);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/ebay/browse?q=${encodeURIComponent(normalizedQuery)}&limit=10`);
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
    <GroupedSection>
      <GroupCard
        header={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill label={loading ? "Refreshing" : "Live"} tone="neutral" size="small" />
              {items.length > 0 ? (
                <a
                  href={`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(normalizedQuery)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] font-semibold text-[#98a0ae]"
                >
                  Live eBay Listings
                </a>
              ) : null}
            </div>
          </div>
        }
      >
        <div className="mb-4">
          <button type="button" onClick={() => setShowQuery((value) => !value)} className="text-[12px] font-semibold text-[#98a0ae]">
            {showQuery ? "Hide query" : "Show query"}
          </button>
          {showQuery ? <p className="mt-2 text-[12px] text-[#7e8694]">{normalizedQuery}</p> : null}
        </div>

        {loading ? (
          <div className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02]">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
                <div className="min-w-0">
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="mt-2 h-3 w-1/2" />
                </div>
                <div className="text-right">
                  <Skeleton className="ml-auto h-4 w-20" />
                  <Skeleton className="mt-2 ml-auto h-3 w-14" />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!loading && error ? <p className="text-[14px] text-[#98a0ae]">Listings unavailable right now.</p> : null}
        {!loading && !error && items.length === 0 ? (
          <p className="text-[14px] text-[#98a0ae]">No live listings yet. PopAlpha will surface evidence as the market forms.</p>
        ) : null}

        {!loading && !error && shownItems.length > 0 ? (
          <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02]">
            {shownItems.map((item, index) => (
              <li key={`${item.externalId || item.itemWebUrl}-${index}`}>
                <a
                  href={item.itemWebUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition hover:bg-white/[0.03]"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-[13px] font-semibold text-[#f5f7fb]">{item.title}</p>
                      <span className="shrink-0 text-[11px] font-medium text-[#7e8694]">{item.condition ?? "n/a"}</span>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-[#8d99a5]">
                      {item.shipping ? `${formatMoney(item.shipping.value, item.shipping.currency)} shipping` : "Shipping unknown"}
                      {item.endTime
                        ? ` • ends ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.endTime))}`
                        : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[13px] font-semibold text-[#eef3f7]">
                      {item.price ? formatMoney(item.price.value, item.price.currency) : "—"}
                    </p>
                    <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8d99a5]">Ask</p>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </GroupCard>
    </GroupedSection>
  );
}
