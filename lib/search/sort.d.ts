export type SearchSort = "relevance" | "newest" | "oldest";

export const SEARCH_SORTS: SearchSort[];

export function parseSearchSort(value: string | null | undefined): SearchSort;

export function sortSearchResults<T extends {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
}>(
  items: T[],
  sort: SearchSort | string | null | undefined,
): T[];
