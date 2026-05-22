"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Market = "EN" | "JP";

export const MARKET_STORAGE_KEY = "popalpha.market.v1";

type MarketContextValue = {
  market: Market;
  setMarket: (next: Market) => void;
};

const MarketContext = createContext<MarketContextValue>({
  market: "EN",
  setMarket: () => {},
});

function readStoredMarket(): Market {
  if (typeof window === "undefined") return "EN";
  try {
    const raw = window.localStorage.getItem(MARKET_STORAGE_KEY);
    if (raw === "JP" || raw === "EN") return raw;
    // iOS persists the same key in lowercase ("en"/"jp") via @AppStorage.
    // Honor both casings so a user who first set the preference on iOS
    // lands in the right view on web without resetting their choice.
    if (raw === "jp") return "JP";
    if (raw === "en") return "EN";
  } catch {}
  return "EN";
}

export function MarketProvider({ children }: { children: ReactNode }) {
  const [market, setMarketState] = useState<Market>("EN");

  // Hydrate from localStorage after mount so SSR and the first client
  // render agree (both produce "EN"); then promote to the stored value.
  useEffect(() => {
    const stored = readStoredMarket();
    if (stored !== market) setMarketState(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab sync: when another tab flips the market, follow it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: StorageEvent) => {
      if (event.key !== MARKET_STORAGE_KEY) return;
      const next = readStoredMarket();
      setMarketState(next);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const setMarket = useCallback((next: Market) => {
    setMarketState(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(MARKET_STORAGE_KEY, next);
      } catch {}
    }
  }, []);

  return (
    <MarketContext.Provider value={{ market, setMarket }}>
      {children}
    </MarketContext.Provider>
  );
}

export function useMarket(): MarketContextValue {
  return useContext(MarketContext);
}
