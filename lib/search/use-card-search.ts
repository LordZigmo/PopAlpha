"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseSharedCardSearchResponse,
  type SharedCardSearchResult,
} from "@/lib/cards/shared-card";

export type CardSearchResult = SharedCardSearchResult;

export function useCardSearch(query: string, delayMs = 240) {
  const [results, setResults] = useState<CardSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setIsLoading(false);
      setError(null);
      setHasSearched(false);
      return;
    }

    const controller = new AbortController();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      setHasSearched(false);

      try {
        const response = await fetch(`/api/search/cards?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
          headers: {
            accept: "application/json",
          },
        });

        if (!response.ok) {
          throw new Error(`Search request failed with ${response.status}`);
        }

        const payload = parseSharedCardSearchResponse(await response.json());
        if (!payload.ok) {
          throw new Error(payload.error ?? "Search unavailable");
        }

        if (requestIdRef.current !== requestId) return;
        setResults(payload.cards ?? []);
        setIsLoading(false);
        setHasSearched(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== requestId) return;
        setResults([]);
        setIsLoading(false);
        setError(err instanceof Error ? err.message : "Search unavailable");
        setHasSearched(true);
      }
    }, delayMs);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [delayMs, query]);

  return {
    results,
    isLoading,
    error,
    hasSearched,
  };
}
