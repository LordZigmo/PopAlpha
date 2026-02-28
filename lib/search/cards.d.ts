import type { NormalizedSearchInput } from "./normalize.mjs";

export type SearchCardRow = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
  primary_image_url?: string | null;
  search_doc_norm: string;
};

export type SearchAliasRow = {
  canonical_slug: string;
  alias_norm: string;
};

export type SearchCardResult = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
  primary_image_url: string | null;
};

export function buildSearchCardResults(args: {
  canonicalRows: SearchCardRow[];
  aliasRows: SearchAliasRow[];
  query: string | NormalizedSearchInput;
  limit?: number;
}): SearchCardResult[];
