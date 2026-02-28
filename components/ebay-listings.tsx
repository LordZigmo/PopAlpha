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
  const [expanded, setExpanded] = useState(false);
  const [showQuery, setShowQuery] = useState(false);

  const normalizedQuery = normalizeBrowseQuery(query);
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
    <GroupedSection title="Live Market Listings" description="Live eBay asks are evidence, not the core signal.">
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
                  View all on eBay
                </a>
              ) : null}
            </div>
            {items.length > 6 ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="min-h-11 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 text-[13px] font-semibold text-[#e5e9f2]"
              >
                {expanded ? "Show less" : "Show all"}
              </button>
            ) : null}
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <GroupCard key={index} inset>
                <div className="flex gap-3">
                  <Skeleton className="h-16 w-16 rounded-2xl" rounded="card" />
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="mt-2 h-3 w-3/4" />
                    <Skeleton className="mt-2 h-3 w-1/2" />
                    <Skeleton className="mt-3 h-8 w-24 rounded-xl" rounded="card" />
                  </div>
                </div>
              </GroupCard>
            ))}
          </div>
        ) : null}

        {!loading && error ? <p className="text-[14px] text-[#98a0ae]">Listings unavailable right now.</p> : null}
        {!loading && !error && items.length === 0 ? (
          <p className="text-[14px] text-[#98a0ae]">No live listings yet. PopAlpha will surface evidence as the market forms.</p>
        ) : null}

        {!loading && !error && shownItems.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shownItems.map((item, index) => (
              <li key={`${item.externalId || item.itemWebUrl}-${index}`}>
                <GroupCard inset className="h-full">
                  <div className="flex items-start gap-3">
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-[#11151d]">
                      {item.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.image} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <div className="h-full w-full bg-white/[0.04]" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-[13px] font-semibold text-[#f5f7fb]">{item.title}</p>
                      <p className="mt-2 text-[12px] text-[#a3abbb]">
                        {item.price ? formatMoney(item.price.value, item.price.currency) : "Price unavailable"}
                      </p>
                      <p className="mt-1 text-[12px] text-[#7e8694]">
                        {item.shipping ? `${formatMoney(item.shipping.value, item.shipping.currency)} shipping` : "Shipping unknown"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Pill label={item.condition ?? "Condition n/a"} tone="neutral" size="small" />
                        {item.endTime ? (
                          <Pill
                            label={`Ends ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.endTime))}`}
                            tone="neutral"
                            size="small"
                          />
                        ) : null}
                      </div>
                      <a
                        href={item.itemWebUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex min-h-11 items-center rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 text-[13px] font-semibold text-[#e5e9f2]"
                      >
                        View listing
                      </a>
                    </div>
                  </div>
                </GroupCard>
              </li>
            ))}
          </ul>
        ) : null}
      </GroupCard>
    </GroupedSection>
  );
}
