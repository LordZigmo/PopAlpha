"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

type CanonicalHeroParallaxProps = {
  imageUrl: string | null;
  title: string;
  subtitle: string;
  leftColumn: ReactNode;
  children: ReactNode;
};

const COLLAPSE_DISTANCE_DESKTOP = 220;
const COLLAPSE_DISTANCE_MOBILE = 180;

export default function CanonicalHeroParallax(props: CanonicalHeroParallaxProps) {
  const { imageUrl, title, subtitle, leftColumn, children } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let rafId = 0;

    const getCollapseDistance = () => (window.innerWidth < 640 ? COLLAPSE_DISTANCE_MOBILE : COLLAPSE_DISTANCE_DESKTOP);

    const update = () => {
      rafId = 0;
      const progress = Math.max(0, Math.min(window.scrollY / getCollapseDistance(), 1));
      root.style.setProperty("--p", String(progress));
    };

    const requestUpdate = () => {
      if (rafId !== 0) return;
      rafId = window.requestAnimationFrame(update);
    };

    requestUpdate();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, []);

  return (
    <section ref={rootRef} className="relative mt-5 [--p:0] sm:mt-6">
      <div className="sticky top-0 z-0 h-[280px] overflow-hidden bg-transparent sm:h-[380px]">
        {imageUrl ? (
          <>
            <div
              className="absolute inset-0"
              style={{
                transform: "translateY(calc(var(--p) * -60px)) scale(calc(1.02 - (var(--p) * 0.02)))",
                opacity: "calc(1 - var(--p))",
                filter: "blur(calc(var(--p) * 6px))",
                transition: "transform 140ms linear, opacity 140ms linear, filter 140ms linear",
                willChange: "transform, opacity, filter",
              }}
            >
              <div className="absolute inset-x-0 top-4 flex justify-center sm:top-6">
                {/* Let the card art feel freefloating and larger while preserving the top border in view. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt={title}
                  className="h-[620px] w-[min(1320px,calc(240vw-2rem))] max-w-none object-contain object-top drop-shadow-[0_28px_64px_rgba(0,0,0,0.5)] sm:h-[900px] sm:w-[min(1760px,calc(240vw-4rem))]"
                />
              </div>
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,0)_0%,rgba(0,0,0,0)_58%,rgba(0,0,0,0.18)_72%,rgba(0,0,0,0.6)_86%,rgba(0,0,0,0.9)_100%)]" />
            <div className="absolute inset-x-0 bottom-0 h-20 bg-[linear-gradient(to_bottom,rgba(16,21,28,0),rgba(16,21,28,0.92))]" />
          </>
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.08),transparent_45%),linear-gradient(to_bottom,rgba(255,255,255,0.04),rgba(8,12,18,0.84))]" />
        )}
      </div>

      <div className="relative z-10 -mt-6 sm:-mt-9">
        <div className="rounded-[var(--radius-panel)] border border-white/10 bg-surface/90 p-[var(--space-panel)] shadow-[0_16px_32px_rgba(0,0,0,0.24)] backdrop-blur-md">
          <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start">
            <div>{leftColumn}</div>

            <div key={imageUrl ?? "no-image"} className="results-enter">
              <p className="text-app text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">{title}</p>
              <p className="text-muted mt-3 text-sm sm:text-base">{subtitle}</p>
              <div className="mt-4">{children}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
