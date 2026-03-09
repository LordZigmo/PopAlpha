"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { POKETRACE_CAMERA_HREF } from "@/lib/poketrace/ui-paths";

type PokeTraceUiCard = {
  canonicalSlug: string;
  canonicalName: string;
  setName: string | null;
  cardNumber: string | null;
  imageUrl: string | null;
  latestPrice: number;
  currency: string | null;
  observedAt: string;
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

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function PokeTraceCameraBetaPanel({
  className,
}: {
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cards, setCards] = useState<PokeTraceUiCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch("/api/poketrace/mobile-samples", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as {
          ok?: boolean;
          cards?: PokeTraceUiCard[];
        } | null;
        if (cancelled || !payload?.ok) return;
        setCards(Array.isArray(payload.cards) ? payload.cards : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const hasCards = cards.length > 0;
  const ctaLabel = useMemo(
    () => (previewUrl ? "Retake photo" : "Open camera"),
    [previewUrl],
  );

  return (
    <section
      id="poketrace-camera"
      className={joinClasses(
        "rounded-[28px] border border-[#1E1E1E] bg-[linear-gradient(160deg,#101726,#0B0B0B)] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.35)] sm:p-6",
        className ?? "mt-8",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7DB6FF]">Camera Beta</p>
          <h2 className="mt-2 text-[24px] font-semibold tracking-[-0.04em] text-[#F0F4FF] sm:text-[30px]">
            Mobile capture is live for public testing
          </h2>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[#A6B2C8]">
            Image capture stays local on your device for now. Use it to test the mobile camera surface, then open one
            of the live Poketrace cards below to verify the beta provider UI on real card pages.
          </p>
        </div>
        <span className="inline-flex items-center rounded-full border border-[#1D4ED8]/30 bg-[#0F172A] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#93C5FD]">
          Public Test
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const nextFile = event.target.files?.[0] ?? null;
          if (!nextFile) return;
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          setPreviewUrl(URL.createObjectURL(nextFile));
        }}
      />

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-[#60A5FA]/30 bg-[linear-gradient(135deg,rgba(37,99,235,0.95),rgba(59,130,246,0.9))] px-5 text-[14px] font-semibold text-white shadow-[0_12px_30px_rgba(37,99,235,0.28)]"
        >
          {ctaLabel}
        </button>
        <Link
          href="/search"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] px-5 text-[14px] font-semibold text-[#D7DCE5]"
        >
          Type a search instead
        </Link>
      </div>

      {previewUrl ? (
        <div className="mt-5 overflow-hidden rounded-[24px] border border-white/[0.08] bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="Camera beta preview" className="h-72 w-full object-cover" />
          <div className="border-t border-white/[0.08] bg-[#0D1118] px-4 py-3 text-[13px] text-[#98A4B8]">
            Local preview only. We are not sending this image into card recognition yet.
          </div>
        </div>
      ) : null}

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-[13px] font-semibold uppercase tracking-[0.14em] text-[#7B879D]">Try Live Poketrace Cards</p>
          {!loading && hasCards ? (
            <span className="text-[12px] text-[#7B879D]">{cards.length} recent cards</span>
          ) : null}
        </div>

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-24 rounded-[22px] border border-white/[0.06] bg-white/[0.03]" />
            ))}
          </div>
        ) : hasCards ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {cards.map((card) => (
              <Link
                key={card.canonicalSlug}
                href={`/cards/${encodeURIComponent(card.canonicalSlug)}?returnTo=${encodeURIComponent(POKETRACE_CAMERA_HREF)}`}
                className="group flex items-center gap-3 rounded-[22px] border border-white/[0.08] bg-white/[0.03] p-3 transition hover:border-[#2563EB]/30 hover:bg-white/[0.05]"
              >
                <div className="h-20 w-14 shrink-0 overflow-hidden rounded-[16px] border border-white/[0.08] bg-[#0D1118]">
                  {card.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-[#F0F4FF]">{card.canonicalName}</p>
                  <p className="mt-1 truncate text-[13px] text-[#94A0B5]">
                    {card.setName ?? "Unknown set"}
                    {card.cardNumber ? ` • #${card.cardNumber}` : ""}
                  </p>
                  <p className="mt-2 text-[14px] font-semibold text-[#8CC3FF]">
                    {formatCurrency(card.latestPrice, card.currency)}
                  </p>
                  <p className="mt-0.5 text-[12px] text-[#7B879D]">Updated {formatRelativeTime(card.observedAt)}</p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="rounded-[22px] border border-white/[0.08] bg-white/[0.03] px-4 py-4 text-[14px] text-[#94A0B5]">
            Poketrace sample cards are not public yet. The capture surface is ready, but we still need more live matched
            observations before we can populate sample links here.
          </div>
        )}
      </div>
    </section>
  );
}
