export type HistoryPointRow = {
  ts: string;
  price: number;
};

export type RawCardMarketVariant = {
  printingId: string;
  label: string;
  descriptorLabel: string | null;
  imageUrl: string | null;
  rarity: string | null;
  currentPrice: number | null;
  changePct7d: number | null;
  scrydexPrice: number | null;
  scrydexAsOfTs: string | null;
  // Legacy auxiliary public signal retained for older callers. New UI should
  // prefer recentMarketSignal* fields and neutral PopAlpha market copy.
  scrydexAskingHighUsd: number | null;
  marketBalancePrice: number | null;
  marketPriceDisplayState: "ALIGNED" | "SIGNAL_HIGHER" | "SIGNAL_LOWER" | "PUBLIC_ONLY" | "UNDER_REVIEW" | "NO_RELIABLE_PRICE" | null;
  recentMarketSignalUsd: number | null;
  recentMarketSignalAsOf: string | null;
  recentMarketSignalDeltaPct: number | null;
  recentMarketSignalDirection: "HIGHER" | "LOWER" | null;
  asOfTs: string | null;
  trendSlope7d: number | null;
  history7d: HistoryPointRow[];
  history30d: HistoryPointRow[];
  history90d: HistoryPointRow[];
  activeListings7d: number | null;
  signalTrend: number | null;
  signalTrendLabel: string | null;
  signalBreakout: number | null;
  signalBreakoutLabel: string | null;
  signalValue: number | null;
  signalValueLabel: string | null;
  signalsHistoryPoints30d: number | null;
  signalsAsOfTs: string | null;
  liquidityScore: number | null;
  liquidityTier: string | null;
  liquidityTone: "warning" | "neutral" | "positive";
  liquidityPriceChanges30d: number | null;
  liquiditySnapshotCount30d: number | null;
  liquiditySpreadPercent: number | null;
};

export type RawCardMarketVariantInput = {
  printingId: string;
  label: string;
  descriptorLabel: string | null;
  imageUrl: string | null;
  rarity: string | null;
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
  stamp: string | null;
};
