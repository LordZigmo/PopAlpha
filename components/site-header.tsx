"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import ShellIdentityMenu from "@/components/navigation/ShellIdentityMenu";
import { useSafeUser } from "@/lib/auth/use-safe-user";

export type SiteHeaderLink = {
  label: string;
  href: string;
};

const DEFAULT_NAV_ITEMS: readonly SiteHeaderLink[] = [
  { label: "Explore", href: "/search" },
  { label: "Market", href: "/" },
  { label: "Sets", href: "/sets" },
  { label: "Portfolio", href: "/portfolio" },
  { label: "Briefs", href: "/about" },
] as const;

type SiteHeaderProps = {
  navItems?: readonly SiteHeaderLink[];
  showSignIn?: boolean;
  primaryCta?: SiteHeaderLink | null;
  leadingSlot?: ReactNode;
  centerSlot?: ReactNode;
  className?: string;
  innerClassName?: string;
  logoPriority?: boolean;
};

export default function SiteHeader({
  navItems = DEFAULT_NAV_ITEMS,
  showSignIn = true,
  primaryCta = { label: "Start free", href: "/sign-up" },
  leadingSlot,
  centerSlot,
  className = "",
  innerClassName = "mx-auto flex h-16 max-w-[1400px] items-center justify-between px-5 sm:px-8",
  logoPriority = false,
}: SiteHeaderProps) {
  const { user } = useSafeUser();
  const navClassName = centerSlot ? "hidden items-center gap-1 xl:flex" : "hidden items-center gap-1 md:flex";

  return (
    <nav className={`fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-[#060608]/80 backdrop-blur-2xl ${className}`}>
      <div className={innerClassName}>
        <div className="flex min-w-0 items-center gap-6">
          <div className="flex items-center gap-4">
            {leadingSlot}
            <Link href="/" className="flex items-center gap-3">
              <Image
                src="/brand/popalpha-icon-transparent.svg"
                alt="PopAlpha logo"
                width={36}
                height={36}
                className="h-9 w-9 shrink-0"
                priority={logoPriority}
              />
              <span className="text-[19px] font-bold tracking-tight text-white">PopAlpha</span>
            </Link>
          </div>

          <div className={navClassName}>
            {navItems.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-[#8A8A8E] transition-colors hover:bg-white/[0.04] hover:text-white"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>

        {centerSlot ? (
          <div className="hidden min-w-0 flex-1 lg:flex lg:max-w-[460px] xl:max-w-[520px]">
            {centerSlot}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          {user ? (
            <ShellIdentityMenu />
          ) : (
            <>
              {showSignIn ? (
                <Link
                  href="/sign-in"
                  className="hidden rounded-lg px-3 py-1.5 text-[13px] font-medium text-[#8A8A8E] transition-colors hover:text-white sm:block"
                >
                  Sign in
                </Link>
              ) : null}
              {primaryCta ? (
                <Link
                  href={primaryCta.href}
                  className="rounded-full bg-[#00B4D8] px-4 py-2 text-[13px] font-semibold text-[#060608] transition-all hover:bg-[#00C9F0] hover:shadow-[0_0_20px_rgba(0,180,216,0.3)]"
                >
                  {primaryCta.label}
                </Link>
              ) : null}
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
