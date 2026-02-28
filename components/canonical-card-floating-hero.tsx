"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

type Props = {
  imageUrl: string | null;
  title: string;
  /** e.g. "Base Set • #4 • 1999" */
  subtitle: string;
  /** Primary price string e.g. "$2,340" or "Collecting" */
  price: string;
  /** e.g. "PSA 10 · 7-day median ask" */
  priceLabel: string;
  /** Pill components for scarcity / liquidity / printing */
  signals: ReactNode;
};

const FADE_DISTANCE = 220;

export default function CanonicalCardFloatingHero({
  imageUrl,
  title,
  subtitle,
  price,
  priceLabel,
  signals,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let rafId = 0;

    const update = () => {
      rafId = 0;
      const p = Math.max(0, Math.min(window.scrollY / FADE_DISTANCE, 1));
      root.style.setProperty("--p", String(p));
    };

    const request = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(update);
    };

    request();
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);

    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", request);
      window.removeEventListener("resize", request);
    };
  }, []);

  return (
    <section
      ref={rootRef}
      className="relative [--p:0] overflow-hidden"
      style={{ minHeight: "700px" }}
    >
      {/* Ambient glow behind the card */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px]"
        style={{
          background:
            "radial-gradient(70% 55% at 50% 20%, rgba(110,76,255,0.14) 0%, transparent 70%)",
          opacity: "calc(1 - var(--p))",
        }}
      />

      {/* Freefloating card art — no frame, just drop-shadow */}
      <div
        className="absolute inset-x-0 top-0 flex justify-center pt-10"
        style={{
          opacity: "calc(1 - var(--p))",
          transform:
            "translateY(calc(var(--p) * -48px)) scale(calc(1 - var(--p) * 0.06))",
          transition: "transform 100ms linear, opacity 100ms linear",
          willChange: "transform, opacity",
          pointerEvents: "none",
        }}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={title}
            className="h-[680px] sm:h-[820px] w-auto max-w-[90vw] object-contain"
            style={{
              filter:
                "drop-shadow(0 28px 64px rgba(0,0,0,0.72)) drop-shadow(0 6px 18px rgba(0,0,0,0.42))",
            }}
          />
        ) : (
          <div className="h-[680px] w-[calc(680px*0.716)] rounded-[28px] border border-white/[0.06] bg-white/[0.03]" />
        )}
      </div>

      {/* Bottom fade — transparent → page background */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-80"
        style={{
          background:
            "linear-gradient(to bottom, transparent 0%, rgba(11,13,18,0.55) 35%, #0b0d12 64%)",
        }}
      />

      {/* Title + price — foreground, bottom of hero */}
      <div className="absolute inset-x-0 bottom-0 px-4 pb-6 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#8c94a3]">
            {subtitle}
          </p>
          <h1 className="mt-1 text-[30px] font-semibold leading-tight tracking-[-0.035em] text-[#f5f7fb] sm:text-[38px]">
            {title}
          </h1>
          <div className="mt-3 flex flex-wrap items-baseline gap-2.5">
            <span className="text-[46px] font-bold leading-none tracking-[-0.04em] tabular-nums text-[#f5f7fb] sm:text-[56px]">
              {price}
            </span>
            <span className="text-[13px] leading-tight text-[#7e8694]">
              {priceLabel}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">{signals}</div>
        </div>
      </div>
    </section>
  );
}
