"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

type CanonicalCardFloatingHeroProps = {
  imageUrl: string | null;
  title: string;
  overlay: ReactNode;
};

const FADE_DISTANCE = 260;

export default function CanonicalCardFloatingHero({ imageUrl, title, overlay }: CanonicalCardFloatingHeroProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let rafId = 0;

    const update = () => {
      rafId = 0;
      const progress = Math.max(0, Math.min(window.scrollY / FADE_DISTANCE, 1));
      root.style.setProperty("--hero-progress", String(progress));
    };

    const requestUpdate = () => {
      if (rafId !== 0) return;
      rafId = window.requestAnimationFrame(update);
    };

    requestUpdate();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, []);

  return (
    <section ref={rootRef} className="relative [--hero-progress:0] pb-36 sm:pb-40">
      <div className="relative mx-auto flex h-[28rem] w-[18rem] items-center justify-center sm:h-[34rem] sm:w-[22rem]">
        <div
          className="absolute inset-0 rounded-[34px]"
          style={{
            transform: "translateY(calc(var(--hero-progress) * -18px)) scale(calc(1 - (var(--hero-progress) * 0.04)))",
            opacity: "calc(1 - (var(--hero-progress) * 0.92))",
            transition: "transform 120ms linear, opacity 120ms linear",
            willChange: "transform, opacity",
          }}
        >
          <div className="absolute inset-0 rounded-[34px] bg-[radial-gradient(circle_at_50%_15%,rgba(255,255,255,0.09),transparent_45%)]" />
          <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-[34px] border border-white/[0.07] bg-[#12161e] shadow-[0_28px_64px_rgba(0,0,0,0.36)]">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt={title} className="h-full w-full object-contain object-center" />
            ) : (
              <span className="px-6 text-center text-[13px] font-semibold text-[#7e8694]">No art</span>
            )}
          </div>
        </div>

        <div
          className="absolute left-1/2 top-[65%] z-10 w-[92%] -translate-x-1/2"
          style={{
            opacity: "calc(1 - (var(--hero-progress) * 0.7))",
            transform: "translateX(-50%) translateY(calc(var(--hero-progress) * -8px))",
            transition: "transform 120ms linear, opacity 120ms linear",
            willChange: "transform, opacity",
          }}
        >
          {overlay}
        </div>
      </div>
    </section>
  );
}
