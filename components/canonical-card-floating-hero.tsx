"use client";

import { useEffect, useRef } from "react";

type Props = {
  imageUrl: string | null;
  altText: string;
};

const FADE_DISTANCE = 400;

export default function CanonicalCardFloatingHero({
  imageUrl,
  altText,
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
      style={{ minHeight: "100vh" }}
    >
      {/* Freefloating card art — no frame, just drop-shadow */}
      <div
        className="absolute inset-x-0 top-0 flex justify-center pt-10"
        style={{
          opacity: "calc(1 - var(--p))",
          transform:
            "translateY(calc(var(--p) * -80px)) scale(calc(1 - var(--p) * 0.03))",
          transition: "transform 100ms linear, opacity 100ms linear",
          willChange: "transform, opacity",
          pointerEvents: "none",
        }}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={altText}
            className="h-[55vh] max-h-[680px] sm:h-[60vh] sm:max-h-[820px] w-auto max-w-[90vw] object-contain"
          />
        ) : (
          <div className="h-[55vh] max-h-[680px] w-[calc(680px*0.716)] rounded-[20px] border border-[#1E1E1E] bg-white/[0.03]" />
        )}
      </div>
    </section>
  );
}
