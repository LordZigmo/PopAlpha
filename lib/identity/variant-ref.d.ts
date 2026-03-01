export type GradedVariantProvider = "PSA" | "CGC" | "BGS" | "TAG";
export type VariantRefBucket = "RAW" | "7_OR_LESS" | "8" | "9" | "10";

export type ParsedVariantRef =
  | {
      printingId: string;
      mode: "RAW";
      provider: null;
      gradeBucket: "RAW";
    }
  | {
      printingId: string;
      mode: "GRADED";
      provider: GradedVariantProvider;
      gradeBucket: Exclude<VariantRefBucket, "RAW">;
    };

export function buildRawVariantRef(printingId: string): string;
export function buildGradedVariantRef(
  printingId: string,
  provider: GradedVariantProvider,
  gradeBucket: string,
): string;
export function buildVariantRef(input: {
  printingId: string;
  provider?: GradedVariantProvider | null;
  grade?: string;
}): string;
export function parseVariantRef(variantRef: string | null | undefined): ParsedVariantRef | null;
