export type HighlightSegment = {
  text: string;
  match: boolean;
};

export function extractHighlightTokens(query: string | null | undefined): string[];
export function buildHighlightSegments(
  text: string | null | undefined,
  queryOrTokens: string | string[],
): HighlightSegment[];
