import {
  extractRawVariantPrintingId,
  isRawHistoryVariantRefForPrinting,
} from "@/lib/identity/variant-ref";

export type RawHistoryIdentityRow = {
  variant_ref: string | null;
};

export function filterRawHistoryRowsForPrinting<T extends RawHistoryIdentityRow>(
  rows: T[],
  printingId: string | null | undefined,
): T[] {
  const normalizedPrintingId = String(printingId ?? "").trim();
  if (normalizedPrintingId) {
    return rows.filter((row) => isRawHistoryVariantRefForPrinting(row.variant_ref, normalizedPrintingId));
  }

  return rows.filter((row) => extractRawVariantPrintingId(row.variant_ref) !== null);
}
