export type GradeSelection = "RAW" | "PSA9" | "PSA10" | "LE_7" | "G8" | "G9" | "G10";
export type GradedSource = "PSA" | "TAG" | "BGS" | "CGC";

export type QueryPrintingHint = {
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
} | null;

export function buildEbayQuery(input: {
  canonicalName: string | null;
  setName: string | null;
  cardNumber: string | null;
  printing: QueryPrintingHint;
  grade: GradeSelection;
  provider?: GradedSource | null;
}): string {
  const parts: string[] = [];
  if (input.canonicalName) parts.push(input.canonicalName);
  if (input.setName) parts.push(input.setName);
  if (input.cardNumber) parts.push(input.cardNumber);

  if (input.printing?.finish === "REVERSE_HOLO") parts.push("reverse holo");
  if (input.printing?.finish === "HOLO") parts.push("holo");
  if (input.printing?.edition === "FIRST_EDITION") parts.push("1st edition");

  const gradedProvider = input.provider ?? "PSA";
  if (input.grade === "PSA9") parts.push("PSA 9");
  if (input.grade === "PSA10") parts.push("PSA 10");
  if (input.grade === "LE_7") parts.push(gradedProvider);
  if (input.grade === "G8") parts.push(`${gradedProvider} 8`);
  if (input.grade === "G9") parts.push(`${gradedProvider} 9`);
  if (input.grade === "G10") parts.push(`${gradedProvider} 10`);

  parts.push("-lot", "-proxy", "-digital", "-custom", "-metal", "-case", "-download", "-coin", "-pack");

  return parts.join(" ").replace(/\s+/g, " ").trim();
}
