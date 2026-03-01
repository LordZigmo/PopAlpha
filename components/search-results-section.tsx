"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { parseSearchSort, SEARCH_SORTS, sortSearchResults } from "@/lib/search/sort.mjs";

type SearchSort = "relevance" | "newest" | "oldest";

type SearchDisplayRow = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  raw_price: number | null;
  primary_image_url: string | null;
};

function formatSearchHref(basePath: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export default function SearchResultsSection({
  rows,
  total,
  page,
  totalPages,
  initialSort,
  currentParams,
}: {
  rows: SearchDisplayRow[];
  total: number;
  page: number;
  totalPages: number;
  initialSort: SearchSort;
  currentParams: Record<string, string>;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [sort, setSort] = useState<SearchSort>(initialSort);

  const sortedRows = useMemo(() => sortSearchResults(rows, sort), [rows, sort]);

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

  return (
    <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-muted text-xs">{total} results.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Sort:</span>
          <select
            value={sort}
            onChange={(event) => updateSort(event.target.value)}
            className="input-themed h-9 min-w-[10rem] rounded-[var(--radius-input)] px-3 text-sm"
            aria-label="Sort search results"
          >
            {SEARCH_SORTS.map((option) => (
              <option key={option} value={option}>
                {option === "relevance" ? "Relevance" : option === "newest" ? "Newest" : "Oldest"}
              </option>
            ))}
          </select>
        </label>
      </div>

      {sortedRows.length === 0 ? (
        <div>
          <p className="text-app text-sm font-semibold">No matches found.</p>
          <p className="text-muted mt-1 text-sm">Try adding set name, year, or card number.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {sortedRows.map((row) => (
            <Link
              key={row.canonical_slug}
              href={`/cards/${encodeURIComponent(row.canonical_slug)}?returnTo=${encodeURIComponent(currentSearchHref)}`}
              className="group block transition duration-200 hover:-translate-y-0.5"
            >
              <div className="relative aspect-[63/88] overflow-hidden rounded-[var(--radius-card)] border-app border bg-surface-soft/24">
                {row.primary_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={row.primary_image_url}
                    alt={row.canonical_name}
                    className="h-full w-full object-cover object-center transition duration-200 group-hover:scale-[1.02]"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_65%)] p-4">
                    <div className="rounded-[var(--radius-input)] border-app border bg-surface/35 px-3 py-2 text-center">
                      <p className="text-app text-xs font-semibold">Image pending</p>
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-2 min-w-0 px-1">
                <p className="text-app truncate text-sm font-semibold">{row.canonical_name}</p>
                <p className="text-muted mt-0.5 truncate text-xs">
                  {row.year ? `${row.year}` : "Year unknown"}
                  {row.set_name ? ` • ${row.set_name}` : ""}
                </p>
                {row.raw_price != null ? (
                  <p className="mt-0.5 text-xs font-semibold" style={{ color: "var(--color-accent)" }}>
                    ${row.raw_price < 1 ? row.raw_price.toFixed(2) : row.raw_price.toFixed(0)} RAW
                  </p>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <span className="text-muted text-xs">
          Page {page} of {totalPages}
        </span>
        <div className="flex items-center gap-2">
          {prevHref ? (
            <Link href={prevHref} className="btn-ghost rounded-[var(--radius-input)] border px-3 py-1.5 text-xs">
              Prev
            </Link>
          ) : (
            <span className="border-app rounded-[var(--radius-input)] border px-3 py-1.5 text-xs text-muted">Prev</span>
          )}
          {nextHref ? (
            <Link href={nextHref} className="btn-ghost rounded-[var(--radius-input)] border px-3 py-1.5 text-xs">
              Next
            </Link>
          ) : (
            <span className="border-app rounded-[var(--radius-input)] border px-3 py-1.5 text-xs text-muted">Next</span>
          )}
        </div>
      </div>
    </section>
  );
}
