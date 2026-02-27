export type GradeSelection = "RAW" | "PSA9" | "PSA10";

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
}): string {
  const parts: string[] = [];
  if (input.canonicalName) parts.push(input.canonicalName);
  if (input.setName) parts.push(input.setName);
  if (input.cardNumber) parts.push(input.cardNumber);

  if (input.printing?.finish === "REVERSE_HOLO") parts.push("reverse holo");
  if (input.printing?.finish === "HOLO") parts.push("holo");
  if (input.printing?.edition === "FIRST_EDITION") parts.push("1st edition");

  if (input.grade === "PSA9") parts.push("PSA 9");
  if (input.grade === "PSA10") parts.push("PSA 10");

  parts.push("-lot", "-proxy", "-digital", "-custom", "-metal", "-case", "-download", "-coin", "-pack");

  return parts.join(" ").replace(/\s+/g, " ").trim();
}
