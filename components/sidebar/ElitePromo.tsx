"use client";

import { motion } from "framer-motion";

export default function ElitePromo({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative mt-6 block w-full cursor-pointer overflow-hidden rounded-xl border border-zinc-700 bg-gradient-to-br from-zinc-800 to-zinc-900 p-4 text-left shadow-[0_12px_30px_rgba(0,0,0,0.22)] transition hover:border-blue-500/40"
    >
      <motion.div
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent"
        animate={{ x: ["-140%", "190%"] }}
        transition={{ duration: 2.3, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
      />

      <div className="relative z-10">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-widest text-blue-400">Elite</span>
          <span className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_12px_rgba(59,130,246,0.9)]" />
        </div>

        <h4 className="text-lg font-bold text-white">Go Elite</h4>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          Unlock community sentiment to see what the next top movers are going to be.
        </p>

        <span className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-blue-600 py-2 text-sm font-bold text-white transition-colors group-hover:bg-blue-500">
          Upgrade Now
        </span>
      </div>
    </button>
  );
}
