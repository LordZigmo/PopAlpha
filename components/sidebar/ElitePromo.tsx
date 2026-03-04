"use client";

import { motion } from "framer-motion";

export default function ElitePromo({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative mt-6 block w-full cursor-pointer overflow-hidden rounded-xl border border-violet-500/30 bg-gradient-to-br from-violet-700 via-purple-700 to-fuchsia-700 px-4 py-4 text-center shadow-[0_12px_30px_rgba(76,29,149,0.35)] transition hover:border-violet-300/40"
    >
      <motion.div
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent"
        animate={{ x: ["-140%", "190%"] }}
        transition={{ duration: 2.3, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
      />

      <span className="relative z-10 inline-flex w-full items-center justify-center text-[20px] font-semibold uppercase tracking-[0.12em] text-white">
        Go Elite
      </span>
    </button>
  );
}
