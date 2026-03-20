"use client";

import { motion } from "framer-motion";

export default function ElitePromo({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative mt-6 block w-full cursor-pointer overflow-hidden rounded-[1.35rem] border border-[#2452C9]/28 bg-[linear-gradient(135deg,#17306A,#102452_52%,#0A1326)] px-4 py-4 text-left shadow-[0_12px_30px_rgba(10,25,65,0.38)] transition hover:border-[#5E8BFF]/38"
    >
      <motion.div
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent"
        animate={{ x: ["-140%", "190%"] }}
        transition={{ duration: 2.3, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
      />

      <div className="relative z-10">
        <span className="inline-flex rounded-full border border-white/[0.1] bg-white/[0.05] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#AFCBFF]">
          Premium signal layer
        </span>
        <p className="mt-4 text-[22px] font-semibold tracking-[-0.03em] text-white">
          Upgrade to Elite
        </p>
        <p className="mt-2 text-[13px] leading-6 text-[#C3D4F3]">
          Unlock deeper market reads, stronger signal visibility, and the full PopAlpha intelligence layer.
        </p>
      </div>
    </button>
  );
}
