export const GRADED_PROVIDERS = ["PSA", "TAG", "BGS", "CGC"] as const;
export const GRADE_BUCKETS = ["LE_7", "G8", "G9", "G10"] as const;

export type GradedProvider = (typeof GRADED_PROVIDERS)[number];
export type GradeBucket = (typeof GRADE_BUCKETS)[number];

export type CardDetailMetrics = {
  trend: number | null;
  breakout: number | null;
  valueZone: number | null;
  asOf: string | null;
  liquidityScore: number | null;
  points30d: number | null;
};

export type CardPrintingPill = {
  printingId: string;
  pillKey: string;
  pillLabel: string;
  finish: string;
  edition: string;
  stamp: string | null;
  imageUrl: string | null;
};

export type CardDetailResponse = {
  canonical: {
    slug: string;
    name: string;
    setName: string | null;
    year: number | null;
    cardNumber: string | null;
    language: string | null;
  };
  defaults: {
    mode: "RAW" | "GRADED";
    printingId: string | null;
    provider: GradedProvider | null;
    gradeBucket: GradeBucket | null;
  };
  raw: {
    variants: Array<
      CardPrintingPill & {
        available: boolean;
        metrics: CardDetailMetrics | null;
      }
    >;
  };
  graded: {
    providers: Array<{
      provider: GradedProvider;
      available: boolean;
    }>;
    grades: Array<{
      gradeBucket: GradeBucket;
      available: boolean;
    }>;
    matrix: Array<{
      printingId: string;
      provider: GradedProvider;
      gradeBucket: GradeBucket;
      available: boolean;
      metrics: CardDetailMetrics | null;
    }>;
  };
};
