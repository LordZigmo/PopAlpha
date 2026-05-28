export const GRADED_PROVIDERS = ["PSA", "TAG", "BGS", "CGC"] as const;
export const GRADE_BUCKETS = ["LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"] as const;

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

export type CardDetailPriceCompare = {
  justtcgPrice: number | null;
  scrydexPrice: number | null;
  pokemontcgPrice: number | null;
  marketPrice: number | null;
  asOf: string | null;
  marketPriceDisplayState: "ALIGNED" | "SIGNAL_HIGHER" | "SIGNAL_LOWER" | "PUBLIC_ONLY" | "UNDER_REVIEW" | "NO_RELIABLE_PRICE" | string | null;
  recentMarketSignalUsd: number | null;
  recentMarketSignalAsOf: string | null;
  recentMarketSignalDeltaPct: number | null;
  recentMarketSignalDirection: "HIGHER" | "LOWER" | string | null;
  providers: Array<{
    provider: "JUSTTCG" | "SCRYDEX" | "PRICECHARTING";
    sourcePrice: number | null;
    sourceCurrency: string | null;
    usdPrice: number | null;
    fxRateUsed: number | null;
    fxSource: "FX_RATES_TABLE" | "ENV_EUR_TO_USD_RATE" | "ENV_JPY_TO_USD_RATE" | "IDENTITY" | "UNKNOWN";
    fxAsOf: string | null;
    asOf: string | null;
  }>;
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

export type FinishKind = "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
export type EditionKind = "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";

export type FinishStampVariant = {
  printingId: string;
  stamp: string | null;
  stampLabel: string;
  edition: EditionKind;
  imageUrl: string | null;
};

export type FinishGroup = {
  finish: FinishKind;
  finishLabel: string;
  defaultPrintingId: string;
  variants: FinishStampVariant[];
};

export type CardDetailResponse = {
  canonical: {
    slug: string;
    name: string;
    setName: string | null;
    year: number | null;
    cardNumber: string | null;
    language: string | null;
    pairedSlug: string | null;
    pairedLanguage: "EN" | "JP" | null;
    pairedImageUrl: string | null;
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
        pricing: CardDetailPriceCompare | null;
      }
    >;
    finishGroups: FinishGroup[];
  };
  pricing: CardDetailPriceCompare | null;
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
