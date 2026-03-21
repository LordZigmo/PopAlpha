"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { parseSearchSort, SEARCH_SORTS, sortSearchResults } from "@/lib/search/sort.mjs";
import type { SetSummarySnapshot } from "@/lib/sets/summary";
import ChangeBadge from "@/components/change-badge";

type SearchSort = "relevance" | "market-price" | "newest" | "oldest";
type SearchPageSize = 24 | 48 | 96;
const PAGE_SIZE_OPTIONS: SearchPageSize[] = [24, 48, 96];

type SearchDisplayRow = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  raw_price: number | null;
  change_pct: number | null;
  change_window: "24H" | "7D" | null;
  primary_image_url: string | null;
};

function formatSearchHref(basePath: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function getSetDescription(setName: string | null | undefined) {
  const normalized = String(setName ?? "").trim().toLowerCase();
  if (normalized === "ascended heroes") {
    return "Ascended Heroes is a character-focused set that saw strong interest at launch. Prices for the top chase cards rose quickly in the first weeks, especially for rare and alternate art versions.\n\nAfter the early spike, most cards pulled back as more supply entered the market. Right now, value is still concentrated in the highest-rarity cards, while mid-tier cards are starting to stabilize.\n\nPopAlpha is tracking renewed momentum in select alt-arts, with a few cards entering the Value Zone after recent price drops.\n\nWatch for breakout signals and changes in graded supply to confirm longer-term trends.";
  }

  return "Showing all tracked cards from this set. Prices are refreshed daily across multiple marketplaces to help you spot trends and find value.";
}

function ExpandableSetDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = text.length > 220;

  return (
    <div className="mt-3 max-w-2xl">
      <p
        className="text-[15px] leading-relaxed text-[#888] whitespace-pre-line"
        style={
          !expanded && shouldCollapse
            ? {
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
            : undefined
        }
      >
        {text}
      </p>
      {shouldCollapse ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-accent)] transition hover:opacity-80"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function formatCurrency(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function ResultCard({
  row,
  currentSearchHref,
  className,
}: {
  row: SearchDisplayRow;
  currentSearchHref: string;
  className?: string;
}) {
  return (
    <Link
      key={row.canonical_slug}
      href={`/cards/${encodeURIComponent(row.canonical_slug)}?returnTo=${encodeURIComponent(currentSearchHref)}`}
      className={`group block transition duration-200 hover:-translate-y-0.5 ${className ?? ""}`.trim()}
    >
      <div className="relative aspect-[63/88] overflow-hidden rounded-xl border border-white/[0.06] bg-[#111]">
        {row.primary_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={row.primary_image_url}
            alt={row.canonical_name}
            className="h-full w-full object-cover object-center transition duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.04),transparent_65%)] p-4">
            <p className="text-[11px] text-[#444]">No image</p>
          </div>
        )}
      </div>
      <div className="mt-2 min-w-0 px-0.5">
        <p className="truncate text-[12px] font-semibold text-[#eee] sm:text-[13px]">{row.canonical_name}</p>
        <p className="mt-0.5 hidden truncate text-[11px] text-[#555] sm:block">
          {row.year ? `${row.year}` : ""}
          {row.set_name ? `${row.year ? " · " : ""}${row.set_name}` : ""}
        </p>
        {row.raw_price != null ? (
          <div className="mt-1 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold tabular-nums text-[#ccc] sm:text-[12px]">
              {formatCurrency(row.raw_price)}
            </span>
            <ChangeBadge pct={row.change_pct} windowLabel={row.change_window} />
          </div>
        ) : null}
      </div>
    </Link>
  );
}

export default function SearchResultsSection({
  rows,
  chaseCards,
  total,
  page,
  totalPages,
  initialSort,
  matchedSetName,
  setSummary,
  pricedOnly,
  currentParams,
}: {
  rows: SearchDisplayRow[];
  chaseCards?: SearchDisplayRow[];
  total: number;
  page: number;
  totalPages: number;
  initialSort: SearchSort;
  matchedSetName?: string | null;
  setSummary?: SetSummarySnapshot | null;
  pricedOnly: boolean;
  currentParams: Record<string, string>;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [sort, setSort] = useState<SearchSort>(initialSort);
  const initialPageSize = Number.parseInt(currentParams.pageSize ?? "24", 10);
  const [pageSize, setPageSize] = useState<SearchPageSize>(
    initialPageSize === 48 || initialPageSize === 96 ? initialPageSize : 24
  );

  const isMarketPriceSort = sort === "market-price";
  const sortedRows = useMemo(() => sortSearchResults(rows, sort), [rows, sort]);
  const featuredChaseCards = useMemo(
    () => (isMarketPriceSort ? (chaseCards ?? []).slice(0, 4) : []),
    [chaseCards, isMarketPriceSort],
  );
  const primaryChaseSlugSet = useMemo(
    () => new Set(featuredChaseCards.slice(0, 3).map((row) => row.canonical_slug)),
    [featuredChaseCards],
  );
  const desktopOnlyChaseSlug = featuredChaseCards[3]?.canonical_slug ?? null;
  const setDescription = useMemo(() => getSetDescription(matchedSetName), [matchedSetName]);
  const mainRows = useMemo(
    () => (
      isMarketPriceSort
        ? sortedRows.filter((row) => !primaryChaseSlugSet.has(row.canonical_slug))
        : sortedRows
    ),
    [isMarketPriceSort, primaryChaseSlugSet, sortedRows],
  );

  const baseParams = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(currentParams)) {
      if (!value) continue;
      params.set(key, value);
    }
    return params;
  }, [currentParams]);

  const currentSearchHref = useMemo(() => formatSearchHref(pathname, baseParams), [baseParams, pathname]);

  const prevHref = useMemo(() => {
    if (page <= 1) return null;
    const params = new URLSearchParams(baseParams);
    params.set("page", String(page - 1));
    params.set("sort", sort);
    return formatSearchHref(pathname, params);
  }, [baseParams, page, pathname, sort]);

  const nextHref = useMemo(() => {
    if (page >= totalPages) return null;
    const params = new URLSearchParams(baseParams);
    params.set("page", String(page + 1));
    params.set("sort", sort);
    return formatSearchHref(pathname, params);
  }, [baseParams, page, pathname, sort, totalPages]);

  function updateSort(nextSort: string) {
    const resolved = parseSearchSort(nextSort);
    setSort(resolved);

    const params = new URLSearchParams(baseParams);
    params.set("sort", resolved);
    router.replace(formatSearchHref(pathname, params), { scroll: false });
  }

  function updatePageSize(nextPageSize: string) {
    const parsed = Number.parseInt(nextPageSize, 10);
    const resolved: SearchPageSize = parsed === 48 || parsed === 96 ? parsed : 24;
    setPageSize(resolved);

    const params = new URLSearchParams(baseParams);
    params.set("pageSize", String(resolved));
    params.set("page", "1");
    params.set("sort", sort);
    router.replace(formatSearchHref(pathname, params), { scroll: false });
  }

  function updatePricedOnly(nextValue: boolean) {
    const params = new URLSearchParams(baseParams);
    if (nextValue) params.set("priced", "1");
    else params.delete("priced");
    params.set("page", "1");
    params.set("sort", sort);
    router.replace(formatSearchHref(pathname, params), { scroll: false });
  }

  return (
    <section className="mt-8">
      {matchedSetName && (
        <div className="mb-6">
          <h2 className="text-[22px] font-bold tracking-tight text-white sm:text-[28px]">
            {matchedSetName}
          </h2>
          <ExpandableSetDescription text={setDescription} />
        </div>
      )}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[12px] text-[#666]">{total} results</p>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <span className="text-[#666]">Sort:</span>
          <select
            value={sort}
            onChange={(event) => updateSort(event.target.value)}
            className="h-8 min-w-[10rem] rounded-lg border border-white/[0.08] bg-[#111] px-3 text-[13px] text-[#ccc] outline-none focus:border-white/[0.14]"
            aria-label="Sort search results"
          >
            {SEARCH_SORTS.map((option) => (
              <option key={option} value={option}>
                {option === "relevance"
                  ? "Relevance"
                  : option === "market-price"
                    ? "Market Price"
                    : option === "newest"
                      ? "Newest"
                      : "Oldest"}
              </option>
            ))}
          </select>
        </label>
      </div>

      {sortedRows.length === 0 ? (
        <div>
          <p className="text-[14px] font-semibold text-white">No matches found.</p>
          <p className="mt-1 text-[13px] text-[#666]">Try adding set name, year, or card number.</p>
        </div>
      ) : (
        <>
          {matchedSetName && setSummary ? (
            <div className="mb-6 rounded-xl border border-white/[0.06] bg-[#0E0E0E] p-4 sm:p-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Market Cap</p>
                  <p className="mt-1 text-[16px] font-bold tabular-nums text-white">{formatCurrency(setSummary.marketCap)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-[#555]">7D Change</p>
                  <p className="mt-1 text-[16px] font-bold tabular-nums text-white">{formatPercent(setSummary.change7dPct)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-[#555]">30D Change</p>
                  <p className="mt-1 text-[16px] font-bold tabular-nums text-white">{formatPercent(setSummary.change30dPct)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Heat Score</p>
                  <p className="mt-1 text-[16px] font-bold tabular-nums text-white">{setSummary.heatScore.toFixed(1)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Breakouts</p>
                  <p className="mt-1 text-[14px] font-semibold tabular-nums text-[#ccc]">{setSummary.breakoutCount}</p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Value Zone</p>
                  <p className="mt-1 text-[14px] font-semibold tabular-nums text-[#ccc]">{setSummary.valueZoneCount}</p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Bullish Trends</p>
                  <p className="mt-1 text-[14px] font-semibold tabular-nums text-[#ccc]">{setSummary.trendBullishCount}</p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-[#555]">Sentiment</p>
                  <p className="mt-1 text-[14px] font-semibold tabular-nums text-[#ccc]">
                    {setSummary.sentimentUpPct == null ? "N/A" : formatPercent(setSummary.sentimentUpPct)}
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {featuredChaseCards.length > 0 ? (
            <div className="mb-6">
              <h3 className="text-[12px] font-semibold uppercase tracking-widest text-[#888]">Chase Cards</h3>
              <p className="mt-1 text-[11px] text-[#555]">Highest current RAW market prices in this set.</p>
              <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-4">
                {featuredChaseCards.map((row, index) => (
                  <ResultCard
                    key={row.canonical_slug}
                    row={row}
                    currentSearchHref={currentSearchHref}
                    className={index === 3 ? "hidden lg:block" : undefined}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {mainRows.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-4">
              {mainRows.map((row) => (
                <ResultCard
                  key={row.canonical_slug}
                  row={row}
                  currentSearchHref={currentSearchHref}
                  className={desktopOnlyChaseSlug === row.canonical_slug ? "lg:hidden" : undefined}
                />
              ))}
            </div>
          ) : null}
        </>
      )}

      <div className="mt-6 flex flex-col gap-4 border-t border-white/[0.04] pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <span className="text-[11px] text-[#555]">
            Page {page} of {totalPages}
          </span>
          <label className="flex items-center gap-2 text-[12px]">
            <span className="text-[#666]">Per page:</span>
            <select
              value={pageSize}
              onChange={(event) => updatePageSize(event.target.value)}
              className="h-7 min-w-[5rem] rounded-md border border-white/[0.08] bg-[#111] px-2 text-[12px] text-[#ccc] outline-none focus:border-white/[0.14]"
              aria-label="Cards per search page"
            >
              {PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex items-center gap-3 text-[12px]">
            <legend className="sr-only">Market data filter</legend>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="priced-filter"
                checked={!pricedOnly}
                onChange={() => updatePricedOnly(false)}
                className="h-3.5 w-3.5 accent-[#00B4D8]"
              />
              <span className="text-[#666]">All cards</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="priced-filter"
                checked={pricedOnly}
                onChange={() => updatePricedOnly(true)}
                className="h-3.5 w-3.5 accent-[#00B4D8]"
              />
              <span className="text-[#666]">Market data only</span>
            </label>
          </fieldset>
        </div>
        <div className="flex items-center gap-2">
          {prevHref ? (
            <Link href={prevHref} className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-[#ccc] transition hover:bg-white/[0.08]">
              Prev
            </Link>
          ) : (
            <span className="rounded-lg border border-white/[0.04] px-3 py-1.5 text-[12px] text-[#333]">Prev</span>
          )}
          {nextHref ? (
            <Link href={nextHref} className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-[#ccc] transition hover:bg-white/[0.08]">
              Next
            </Link>
          ) : (
            <span className="rounded-lg border border-white/[0.04] px-3 py-1.5 text-[12px] text-[#333]">Next</span>
          )}
        </div>
      </div>
    </section>
  );
}
