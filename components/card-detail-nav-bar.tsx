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
        className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.04] text-[#d7dbe5]"
      >
        <span className="text-[26px] leading-none">‹</span>
      </Link>
    </div>
  );
}
