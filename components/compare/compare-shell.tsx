import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

// Shared minimalist frame for every marketing comparison page: a light wordmark
// header, a single narrow column, and an optional footnote line. No app rails.
export default function CompareShell({
  children,
  footnote,
}: {
  children: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F0F0F0]">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-6 py-6">
        <Link href="/" aria-label="PopAlpha home" className="flex items-center">
          <Image
            src="/brand/popalpha-modern-white.png"
            alt="PopAlpha"
            width={840}
            height={182}
            className="h-8 w-auto"
          />
        </Link>
        <Link
          href="#waitlist"
          className="text-[14px] text-[#8A8A8E] transition-colors hover:text-white"
        >
          Join waitlist
        </Link>
      </header>

      <article className="mx-auto max-w-2xl px-6 pb-28 pt-6 sm:pt-10">
        {children}
        {footnote ? <p className="mt-16 text-[14px] text-[#6B6B6B]">{footnote}</p> : null}
      </article>
    </div>
  );
}
