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
  justtcgPrice: number | null;
  justtcgAsOfTs: string | null;
  scrydexPrice: number | null;
  scrydexAsOfTs: string | null;
  // Phase C-2 (2026-05-16): asking-anchored value (USD) from scrydex's
  // `market` field. Headline `scrydexPrice` after Phase A is scrydex's
  // `low` (matches TCGplayer's published Market Price label, which is
  // sold-anchored). `scrydexAskingHighUsd` preserves the asking value
  // so the card detail surface can render "Asking: $X" alongside the
  // headline. Useful on thin-liquidity cards where low and market
  // diverge (Mewtwo VSTAR JP: low ~$29 vs market ~$50). Null when
  // scrydex didn't return a market value or the latest observation
  // predates this column's introduction.
  scrydexAskingHighUsd: number | null;
  marketBalancePrice: number | null;
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
