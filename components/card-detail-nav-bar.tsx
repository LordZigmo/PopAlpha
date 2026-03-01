"use client";

import Link from "next/link";

export default function CardDetailNavBar({
  backHref,
}: {
  title?: string;
  subtitle?: string;
  backHref?: string;
}) {
  return (
    <div className="pointer-events-none fixed left-3 top-[max(env(safe-area-inset-top),0.5rem)] z-50 sm:left-4">
      <Link
        href={backHref ?? "/search"}
        aria-label="Back"
        className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-[#1E1E1E] bg-[#0A0A0A]/60 text-[#6B6B6B] transition hover:text-[#F0F0F0]"
      >
        <span className="text-[26px] leading-none">&lsaquo;</span>
      </Link>
    </div>
  );
}
