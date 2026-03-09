"use client";

import { useEffect, useState } from "react";

type PokeTraceUiEntry = {
  providerVariantId: string;
  providerSetId: string | null;
  cardName: string;
  price: number;
  currency: string | null;
  observedAt: string;
  providerSource: string | null;
  providerTier: string | null;
  providerCondition: string | null;
  imageUrl: string | null;
};

type PokeTraceUiCard = {
  canonicalSlug: string;
  canonicalName: string;
  setName: string | null;
  cardNumber: string | null;
  year: number | null;
  printingId: string | null;
  imageUrl: string | null;
  latestPrice: number;
  currency: string | null;
  observedAt: string;
  entries: PokeTraceUiEntry[];
};

function formatCurrency(value: number, currency: string | null): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency?.toUpperCase() || "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatRelativeTime(value: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(Math.abs(diffMs) / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatMeta(entry: PokeTraceUiEntry): string {
  const parts = [
    entry.providerSource,
    entry.providerTier?.replace(/_/g, " "),
    entry.providerCondition,
  ].filter(Boolean);
  return parts.join(" · ") || "Latest matched Poketrace reading";
}

export default function PokeTraceBetaCard({
  slug,
  printingId,
}: {
  slug: string;
  printingId: string | null;
}) {
  const [card, setCard] = useState<PokeTraceUiCard | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const url = new URL(`/api/cards/${encodeURIComponent(slug)}/poketrace`, window.location.origin);
        if (printingId) url.searchParams.set("printing", printingId);
        const response = await fetch(url.toString(), {
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = await response.json().catch(() => null) as {
          ok?: boolean;
          card?: PokeTraceUiCard | null;
        } | null;
        if (cancelled || !payload?.ok) return;
        setCard(payload.card ?? null);
      } catch {
        if (!cancelled) setCard(null);
      }
    }

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, printingId]);

  if (!card) return null;

  return (
    <div className="mt-3 rounded-[20px] border border-[#1D4ED8]/25 bg-[linear-gradient(145deg,rgba(10,16,30,0.98),rgba(10,10,10,0.96))] px-4 py-4 shadow-[0_18px_50px_rgba(29,78,216,0.12)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7DB6FF]">Poketrace Beta</p>
          <p className="mt-1 text-[14px] text-[#D6E6FF]">Public mobile source preview. Not blended into market price yet.</p>
        </div>
        <span className="inline-flex items-center rounded-full border border-[#1D4ED8]/30 bg-[#0F172A] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#93C5FD]">
          Test
        </span>
      </div>

      <div className="mt-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-[28px] font-semibold tracking-[-0.04em] text-[#F8FBFF]">
            {formatCurrency(card.latestPrice, card.currency)}
          </p>
          <p className="mt-1 text-[13px] text-[#8FB8F8]">
            Latest matched observation · {formatRelativeTime(card.observedAt)}
          </p>
        </div>
        {card.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.imageUrl}
            alt=""
            className="h-20 w-14 rounded-xl border border-white/[0.08] object-cover"
          />
        ) : null}
      </div>

      <div className="mt-4 space-y-2">
        {card.entries.slice(0, 2).map((entry) => (
          <div
            key={entry.providerVariantId}
            className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-[#F0F6FF]">{entry.cardName}</p>
              <p className="truncate text-[12px] text-[#7E8DA8]">{formatMeta(entry)}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[13px] font-semibold tabular-nums text-[#F0F6FF]">
                {formatCurrency(entry.price, entry.currency)}
              </p>
              <p className="text-[12px] text-[#7E8DA8]">{formatRelativeTime(entry.observedAt)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
