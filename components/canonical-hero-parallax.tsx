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
    <section ref={rootRef} className="relative mt-4 [--p:0]">
      <div className="sticky top-0 z-0 h-[240px] overflow-hidden rounded-[var(--radius-panel)] border-app border bg-surface-soft/35 sm:h-[320px]">
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
              {/* Keep the top half of the card visible while the lower business fades under the panel. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={title}
                className="absolute left-1/2 top-0 h-[280px] w-[min(560px,92vw)] max-w-none -translate-x-1/2 object-cover object-[center_18%] drop-shadow-[0_24px_56px_rgba(0,0,0,0.48)] sm:h-[380px]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,0)_0%,rgba(0,0,0,0)_45%,rgba(0,0,0,0.35)_62%,rgba(0,0,0,0.85)_80%,rgba(0,0,0,1)_100%)]" />
            <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(8,12,18,0.24),rgba(8,12,18,0.06)_22%,transparent_38%)]" />
          </>
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.08),transparent_45%),linear-gradient(to_bottom,rgba(255,255,255,0.04),rgba(8,12,18,0.84))]" />
        )}
      </div>

      <div className="relative z-10 -mt-[90px] sm:-mt-[110px]">
        <div className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
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
