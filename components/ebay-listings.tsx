"use client";

import { useEffect, useState } from "react";
import { Pill, Skeleton } from "@/components/ios-grouped-ui";

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
  queries: string[];
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

function totalAskValue(item: Listing): number | null {
  const price = item.price?.value ? Number.parseFloat(item.price.value) : Number.NaN;
  const shipping = item.shipping?.value ? Number.parseFloat(item.shipping.value) : 0;
  if (!Number.isFinite(price)) return null;
  return price + (Number.isFinite(shipping) ? shipping : 0);
}

export default function EbayListings({ queries, canonicalSlug, printingId, grade }: EbayListingsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Listing[]>([]);
  const [totalAsks, setTotalAsks] = useState<number>(0);
  const [showQuery, setShowQuery] = useState(false);

  const normalizedQueries = queries.map(normalizeBrowseQuery).filter(Boolean);
  const primaryQuery = normalizedQueries[0] ?? "";
  const lowestFive = [...items]
    .filter((item) => totalAskValue(item) !== null)
    .sort((a, b) => (totalAskValue(a) ?? 0) - (totalAskValue(b) ?? 0))
    .slice(0, 5);
  const highestFive = [...items]
    .filter((item) => totalAskValue(item) !== null)
    .sort((a, b) => (totalAskValue(b) ?? 0) - (totalAskValue(a) ?? 0))
    .slice(0, 5);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", "50");
        for (const query of normalizedQueries) params.append("q", query);
        const response = await fetch(`/api/ebay/browse?${params.toString()}`);
        const payload = (await response.json()) as { ok: boolean; items?: Listing[]; total?: number; error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "Could not load eBay listings.");
        }
        if (!cancelled) {
          const nextItems = payload.items ?? [];
          setItems(nextItems);
          setTotalAsks(Number(payload.total ?? nextItems.length));
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
          setTotalAsks(0);
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
  }, [canonicalSlug, printingId, grade, normalizedQueries.join("||")]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Pill label={loading ? "Refreshing" : "Live"} tone="neutral" size="small" />
          {items.length > 0 && primaryQuery ? (
            <a
              href={`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(primaryQuery)}`}
              target="_blank"
              rel="noreferrer"
              className="text-[14px] font-semibold text-[#777]"
            >
              Live eBay Listings
            </a>
          ) : null}
          {!loading && !error ? (
            <span className="text-[14px] font-semibold text-[#6B6B6B]">{totalAsks} asks</span>
          ) : null}
        </div>
      </div>

      <div className="mb-4">
        <button type="button" onClick={() => setShowQuery((value) => !value)} className="text-[14px] font-semibold text-[#777]">
          {showQuery ? "Hide query" : "Show query"}
        </button>
        {showQuery ? (
          <div className="mt-2 space-y-1">
            {normalizedQueries.map((query) => (
              <p key={query} className="text-[14px] text-[#666]">{query}</p>
            ))}
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="divide-y divide-[#1E1E1E] overflow-hidden rounded-2xl border border-[#1E1E1E] bg-white/[0.02]">
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

      {!loading && error ? <p className="text-[16px] text-[#777]">Listings unavailable right now.</p> : null}
      {!loading && !error && items.length === 0 ? (
        <p className="text-[16px] text-[#777]">No live listings yet. PopAlpha will surface evidence as the market forms.</p>
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[
            { title: "Lowest Asks", entries: lowestFive },
            { title: "Highest Asks", entries: highestFive },
          ].map((section) => (
            <div key={section.title}>
              <p className="mb-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">{section.title}</p>
              <ul className="divide-y divide-[#1E1E1E] overflow-hidden rounded-2xl border border-[#1E1E1E] bg-white/[0.02]">
                {section.entries.map((item, index) => (
                  <li key={`${section.title}-${item.externalId || item.itemWebUrl}-${index}`}>
                    <a
                      href={item.itemWebUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition hover:bg-[#1A1A1A]"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-[15px] font-semibold text-[#F0F0F0]">{item.title}</p>
                          <span className="shrink-0 text-[13px] font-medium text-[#666]">{item.condition ?? "n/a"}</span>
                        </div>
                        <p className="mt-1 truncate text-[13px] text-[#6B6B6B]">
                          {item.shipping ? `${formatMoney(item.shipping.value, item.shipping.currency)} shipping` : "Shipping unknown"}
                          {item.endTime
                            ? ` • ends ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.endTime))}`
                            : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[15px] font-semibold tabular-nums text-[#F0F0F0]">
                          {item.price ? formatMoney(item.price.value, item.price.currency) : "—"}
                        </p>
                        <p className="mt-1 text-[13px] font-medium uppercase tracking-[0.08em] text-[#6B6B6B]">
                          {totalAskValue(item) !== null ? `${formatMoney(String(totalAskValue(item)), item.price?.currency ?? "USD")} total` : "Ask"}
                        </p>
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
