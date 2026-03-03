"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

type PricingModalProps = {
  open: boolean;
  onClose: () => void;
};

type TierConfig = {
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  bullets: string[];
  ctaLabel: string;
  href?: string;
  featured?: boolean;
};

const TIERS: TierConfig[] = [
  {
    name: "Trainer",
    price: "$0",
    cadence: "/month",
    blurb: "Get your footing in the market and start seeing your collection like it finally matters.",
    bullets: [
      "Browse cards, sets, and price movement",
      "Use the free PopAlpha Scout experience",
      "Get the foundation for market tracking",
    ],
    ctaLabel: "Current Free Tier",
  },
  {
    name: "Ace",
    price: "$12.99",
    cadence: "/month",
    blurb: "Move from curious collector to confident operator with sharper reads and faster conviction.",
    bullets: [
      "Higher-performance AI analysis",
      "Deeper tools for active collectors",
      "A faster path from noise to signal",
    ],
    ctaLabel: "Choose Ace",
    href: process.env.NEXT_PUBLIC_STRIPE_ACE_CHECKOUT_URL,
  },
  {
    name: "Elite",
    price: "$19.99",
    cadence: "/month",
    blurb: "See the market the way serious money does, with the signal layer built for high-conviction decisions.",
    bullets: [
      "Full premium intelligence access",
      "Whale Radar and top-tier signal visibility",
      "The strongest workflow for serious tracking",
    ],
    ctaLabel: "Go Elite",
    href: process.env.NEXT_PUBLIC_STRIPE_ELITE_CHECKOUT_URL,
    featured: true,
  },
];

export default function PricingModal({ open, onClose }: PricingModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const modal = (
    <AnimatePresence>
      {open ? (
        <>
          <motion.button
            type="button"
            aria-label="Close pricing"
            onClick={onClose}
            className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-[80] flex items-center justify-center px-4 py-8 md:px-8"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <div className="w-full max-w-3xl overflow-hidden rounded-[2.2rem] border border-white/[0.06] bg-[linear-gradient(180deg,#10131A_0%,#090909_22%,#090909_100%)] shadow-[0_36px_90px_rgba(0,0,0,0.58)] ring-1 ring-white/[0.03]">
              <div className="border-b border-white/[0.05] bg-[radial-gradient(circle_at_top_left,rgba(29,78,216,0.18),transparent_38%),radial-gradient(circle_at_top_right,rgba(79,70,229,0.14),transparent_34%)] px-6 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-[28px] font-semibold tracking-[-0.04em] text-white">Start Your Journey</h2>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full border border-[#1E1E1E] px-3 py-1.5 text-[12px] font-semibold text-[#A3A3A3] transition hover:text-white"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="grid gap-4 px-6 py-6 md:grid-cols-3 md:items-stretch">
                {TIERS.map((tier) => {
                  const cta = tier.href ? (
                    <Link
                      href={tier.href}
                      className={[
                        "mt-5 inline-flex w-full items-center justify-center rounded-2xl border px-4 py-3 text-[14px] font-semibold transition",
                        tier.featured
                          ? "border-[#2A5BFF] bg-[#1D4ED8] text-white hover:bg-[#2563EB]"
                          : "border-[#1E1E1E] bg-white/[0.06] text-white hover:bg-white/[0.1]",
                      ].join(" ")}
                    >
                      {tier.ctaLabel}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="mt-5 inline-flex w-full items-center justify-center rounded-2xl border border-[#1E1E1E] bg-white/[0.04] px-4 py-3 text-[14px] font-semibold text-[#8A8A8A]"
                    >
                      {tier.ctaLabel}
                    </button>
                  );

                  return (
                    <div
                      key={tier.name}
                      className={[
                        "relative rounded-[1.75rem] border px-5 py-5",
                        tier.featured
                          ? "border-[#2146B6] bg-[linear-gradient(180deg,rgba(29,78,216,0.22),rgba(11,16,28,0.96)_38%,rgba(9,9,9,0.98)_100%)] shadow-[0_22px_50px_rgba(29,78,216,0.16)] md:-translate-y-2"
                          : "border-[#1E1E1E] bg-[#101010]",
                      ].join(" ")}
                    >
                      {tier.featured ? (
                        <div className="absolute right-4 top-4 rounded-full border border-[#2F5DDB] bg-[#1D4ED8]/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#B9D7FF]">
                          Best Value
                        </div>
                      ) : null}
                      <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#8FBFFF]">{tier.name}</p>
                      <div className="mt-4 flex items-end gap-1">
                        <span className={tier.featured ? "text-[40px] font-semibold tracking-[-0.06em] text-white" : "text-[34px] font-semibold tracking-[-0.05em] text-white"}>
                          {tier.price}
                        </span>
                        <span className="pb-1 text-[13px] text-[#8A8A8A]">{tier.cadence}</span>
                      </div>
                      <p className="mt-4 min-h-20 text-[14px] leading-6 text-[#C2C2C2]">{tier.blurb}</p>
                      <ul className="mt-4 space-y-2 text-[13px] text-[#9FA4AE]">
                        {tier.bullets.map((bullet) => (
                          <li key={bullet} className="flex items-start gap-2">
                            <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-[#6EA8FF]" />
                            <span>{bullet}</span>
                          </li>
                        ))}
                      </ul>
                      {cta}
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );

  return createPortal(modal, document.body);
}
