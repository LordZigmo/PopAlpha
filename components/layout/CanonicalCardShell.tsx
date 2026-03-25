import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import MobileNav from "@/components/navigation/MobileNav";
import ShellIdentityMenu from "@/components/navigation/ShellIdentityMenu";

export default function CanonicalCardShell({
  backHref,
  children,
  rightRail,
}: {
  backHref: string;
  children: ReactNode;
  rightRail: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F0F0F0]">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.04] bg-[#0A0A0A]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <Link
              href={backHref}
              aria-label="Back"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.03] text-[#999] transition hover:bg-white/[0.06] hover:text-white"
            >
              <span className="text-[20px] leading-none">‹</span>
            </Link>
            <Link href="/" className="flex items-center gap-2">
              <Image
                src="/brand/popalpha-icon-transparent.svg"
                alt="PopAlpha"
                width={28}
                height={28}
                className="h-7 w-7"
              />
              <span className="text-[15px] font-bold tracking-tight text-white">PopAlpha</span>
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <nav className="hidden items-center gap-5 lg:flex">
              <Link href="/search" className="text-[13px] font-medium text-[#666] transition hover:text-white">
                Search
              </Link>
              <Link href="/sets" className="text-[13px] font-medium text-[#666] transition hover:text-white">
                Sets
              </Link>
              <Link href="/portfolio" className="text-[13px] font-medium text-[#666] transition hover:text-white">
                Portfolio
              </Link>
            </nav>
            <ShellIdentityMenu />
          </div>
        </div>
      </header>

      <div className="pt-14">
        <div className="mx-auto min-h-[calc(100vh-3.5rem)] max-w-[1600px] lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(22rem,3fr)]">
          <div className="min-w-0">
            {children}
          </div>
          <aside className="relative hidden lg:block">
            <div className="sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto border-l border-[#1E1E1E] bg-[#0A0A0A]/95 backdrop-blur-xl">
              {rightRail}
            </div>
          </aside>
        </div>
      </div>

      <MobileNav />
    </div>
  );
}
