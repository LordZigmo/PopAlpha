export type GradeSelection = "RAW" | "PSA9" | "PSA10" | "LE_7" | "G8" | "G9" | "G10";
export type GradedSource = "PSA" | "TAG" | "BGS" | "CGC";

export type QueryPrintingHint = {
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
} | null;

type EbayQueryInput = {
  canonicalName: string | null;
  setName: string | null;
  cardNumber: string | null;
  printing: QueryPrintingHint;
  grade: GradeSelection;
  provider?: GradedSource | null;
};

function normalizeQueryTerm(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueQueries(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

function buildQueryParts(input: EbayQueryInput, options?: { includeSet?: boolean; includeCardNumber?: boolean }): string[] {
  const parts: string[] = [];
  const exclusions = ["-lot", "-proxy", "-digital", "-custom", "-metal", "-case", "-download", "-coin", "-pack"];
  const canonicalName = normalizeQueryTerm(input.canonicalName);
  const setName = normalizeQueryTerm(input.setName);
  const cardNumber = normalizeQueryTerm(input.cardNumber);
  if (canonicalName) parts.push(canonicalName);
  if (options?.includeCardNumber !== false && cardNumber) parts.push(cardNumber);
  parts.push("pokemon");
  if (options?.includeSet !== false && setName) parts.push(setName);

  if (input.printing?.finish === "REVERSE_HOLO") parts.push("reverse holo");
  if (input.printing?.finish === "HOLO") parts.push("holo");
  if (input.printing?.edition === "FIRST_EDITION") parts.push("1st edition");

  const gradedProvider = input.provider ?? "PSA";
  const isGraded = input.grade !== "RAW";

  if (!isGraded) {
    exclusions.push("-psa", "-cgc", "-bgs", "-beckett", "-tag", "-graded", "-slab", "-sgc");
  } else {
    parts.push("graded");
    if (gradedProvider === "BGS") {
      parts.push("BGS");
      parts.push("Beckett");
    }
  }

  if (input.grade === "PSA9") parts.push("PSA 9");
  if (input.grade === "PSA10") parts.push("PSA 10");
  if (input.grade === "LE_7") parts.push(gradedProvider);
  if (input.grade === "G8") parts.push(`${gradedProvider} 8`);
  if (input.grade === "G9") parts.push(`${gradedProvider} 9`);
  if (input.grade === "G10") parts.push(`${gradedProvider} 10`);

  parts.push(...exclusions);
  return parts;
}

export function buildEbaySearchQueries(input: EbayQueryInput): string[] {
  const queries = [
    buildQueryParts(input, { includeSet: true, includeCardNumber: true }).join(" "),
    buildQueryParts(input, { includeSet: false, includeCardNumber: true }).join(" "),
    [`"${normalizeQueryTerm(input.canonicalName)}"`, normalizeQueryTerm(input.cardNumber), "pokemon"].filter(Boolean).join(" "),
  ];
  return uniqueQueries(queries);
}

export function buildEbayQuery(input: EbayQueryInput): string {
  return buildEbaySearchQueries(input)[0] ?? "";
}
