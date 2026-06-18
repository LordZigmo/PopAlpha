"use client";

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import AppStoreBadge from "@/components/landing/app-store-badge";
import PhoneFrame from "@/components/landing/phone-frame";

const EASE = [0.16, 1, 0.3, 1] as const;

export default function LandingHero() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (reduce) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--px", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    el.style.setProperty("--py", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  }
  function onLeave() {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--px", "0");
    el.style.setProperty("--py", "0");
  }

  return (
    <section className="relative isolate overflow-hidden bg-[#05060A]">
      {/* background */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(110%_80%_at_15%_0%,rgba(13,38,58,0.85),transparent_55%),radial-gradient(120%_90%_at_92%_18%,rgba(8,48,44,0.85),transparent_55%),linear-gradient(180deg,#05060A,#05060A)]" />
        <div className="absolute -top-24 left-[8%] h-[480px] w-[480px] rounded-full bg-[#22D3EE]/[0.12] blur-[150px]" />
        <div className="absolute right-[6%] top-16 h-[460px] w-[460px] rounded-full bg-[#2DD4BF]/[0.10] blur-[160px]" />
        <div className="absolute inset-0 opacity-[0.05] [background-image:linear-gradient(rgba(255,255,255,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.5)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(75%_60%_at_50%_25%,black,transparent_78%)]" />
      </div>

      <div className="relative mx-auto grid min-h-[100svh] max-w-[1320px] grid-cols-1 items-center gap-12 px-5 pb-16 pt-28 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:gap-12 lg:pt-20 xl:gap-20">
        {/* ── Copy ── */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="mx-auto max-w-[620px] text-center lg:mx-0 lg:text-left"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-[12px] font-medium text-[#9EB2C2] backdrop-blur-xl">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#22D3EE] opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#22D3EE]" />
            </span>
            Live on the App Store
          </span>

          <h1 className="mt-6 text-[clamp(2.6rem,5.4vw,4.6rem)] font-semibold leading-[0.98] tracking-[-0.045em] text-white">
            Scan your Pokémon cards
            <span className="block bg-gradient-to-r from-[#9BE7F6] via-[#36D6E7] to-[#34D399] bg-clip-text text-transparent">
              Free. No limits.
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-[480px] text-[clamp(1.05rem,1.5vw,1.25rem)] leading-[1.55] text-[#C2CAD3] lg:mx-0">
            Scan as many cards as you want — it never costs a thing. Point your phone at any card
            and see what it&rsquo;s worth in seconds.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4 lg:justify-start">
            <AppStoreBadge size="lg" data-cta="hero" />
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
            {["260ms scans", "English & Japanese", "Free, no limits"].map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-[12.5px] font-medium text-[#C2CAD3] backdrop-blur-xl"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[#34D399] shadow-[0_0_8px_#34D399]" />
                {t}
              </span>
            ))}
          </div>
        </motion.div>

        {/* ── Hero device (the scan) ── */}
        <motion.div
          ref={ref}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
          initial={reduce ? false : { opacity: 0, y: 40, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.12 }}
          style={{ "--px": "0", "--py": "0" } as CSSProperties}
          className="relative mx-auto w-[260px] sm:w-[300px] lg:w-[330px]"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-10 rounded-[3.5rem] bg-[radial-gradient(circle_at_50%_30%,rgba(34,211,238,0.28),transparent_65%)] blur-2xl"
          />
          <div
            className="relative"
            style={{
              translate: "calc(var(--px,0) * 16px) calc(var(--py,0) * 12px)",
              transition: "translate 0.4s cubic-bezier(0.16,1,0.3,1)",
            }}
          >
            <PhoneFrame
              src="/screenshots/scan-ar.jpg"
              alt="PopAlpha scanning a Paldean Wooper card and showing its $3.11 price"
              className="w-full -rotate-[3deg]"
              priority
              sizes="(max-width: 1024px) 80vw, 330px"
            />
            {/* floating price callout */}
            <motion.div
              initial={reduce ? false : { opacity: 0, scale: 0.85, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE, delay: 0.7 }}
              className="absolute bottom-12 -left-4 inline-flex items-center gap-2 rounded-2xl border border-white/15 bg-black/55 px-4 py-2.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.85)] backdrop-blur-2xl"
            >
              <span className="flex h-2 w-2"><span className="h-2 w-2 rounded-full bg-[#34D399] shadow-[0_0_10px_#34D399]" /></span>
              <span className="text-[13px] font-semibold text-white">Scanned in 260ms</span>
            </motion.div>
          </div>
        </motion.div>
      </div>

      {/* dissolve into the next section */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-[linear-gradient(180deg,transparent,#05060A)]"
      />
    </section>
  );
}
