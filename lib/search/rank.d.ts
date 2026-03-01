import type { NormalizedSearchInput } from "./normalize.mjs";

export type SearchRankSignals = {
  exact_norm_match: boolean;
  set_number_match: boolean;
  number_match: boolean;
  exact_name_match: boolean;
  alias_match: boolean;
  token_coverage: number;
  prefix_match: boolean;
  score: number;
  q_norm: string;
  canonical_name_norm: string;
  set_tokens: string[];
  name_intent_norm: string;
};

export function computeSearchSignals(
  row: {
    canonical_slug: string;
    canonical_name: string;
    set_name: string | null;
    card_number: string | null;
    year: number | null;
    search_doc_norm: string;
  },
  aliasNorms: string[],
  query: string | NormalizedSearchInput,
): SearchRankSignals;

export function compareRankedSearchRows(
  a: {
    canonical_slug: string;
    canonical_name: string;
    set_name: string | null;
    year: number | null;
    score: number;
    set_number_match?: boolean;
    number_match?: boolean;
    exact_name_match?: boolean;
  },
  b: {
    canonical_slug: string;
    canonical_name: string;
    set_name: string | null;
    year: number | null;
    score: number;
    set_number_match?: boolean;
    number_match?: boolean;
    exact_name_match?: boolean;
  },
): number;
