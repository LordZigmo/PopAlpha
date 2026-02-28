export type NormalizedSearchInput = {
  normalized_text: string;
  tokens: string[];
  numeric_tokens: string[];
  collector_number_parts: string[];
};

export function normalizeSearchInput(input: string | null | undefined): NormalizedSearchInput;
export function normalizeSearchText(input: string | null | undefined): string;
export function buildCanonicalSearchDoc(fields: {
  canonical_name: string | null | undefined;
  subject?: string | null | undefined;
  set_name?: string | null | undefined;
  card_number?: string | null | undefined;
  year?: number | null | undefined;
}): string;
