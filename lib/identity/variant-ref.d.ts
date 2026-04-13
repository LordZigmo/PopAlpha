export type GradedVariantProvider = "PSA" | "CGC" | "BGS" | "TAG";
export type VariantRefBucket = "RAW" | "7_OR_LESS" | "8" | "9" | "9_5" | "10" | "10_PERFECT";

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
/**
 * Provider-history keys keep providerVariantId for RAW market history.
 * They are storage keys and may differ from canonical display variant refs.
 */
export function buildProviderHistoryVariantRef(input: {
  printingId?: string | null;
  canonicalSlug?: string | null;
  provider: string;
  providerVariantId: string;
}): string;
/**
 * Parses canonical display variant refs only.
 * Provider-history RAW keys are intentionally outside this parser contract.
 */
export function parseVariantRef(variantRef: string | null | undefined): ParsedVariantRef | null;
