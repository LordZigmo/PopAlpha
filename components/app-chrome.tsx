"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import ThemeToggle from "@/components/theme-toggle";
import NavSearchForm from "@/components/nav-search-form";

function SideRail({ pathname }: { pathname: string }) {
  const items = [
    { href: "/", label: "Home", glyph: "H" },
    { href: "/portfolio", label: "Portfolio", glyph: "P" },
    { href: "/about", label: "About", glyph: "A" },
  ];

  return (
    <nav
      aria-label="Quick navigation"
      className="group fixed right-4 top-1/2 z-50 hidden -translate-y-1/2 overflow-hidden rounded-[1.35rem] border border-[#1E1E1E] bg-[#0A0A0A]/88 shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-sm transition-[width,background-color,border-color] duration-300 ease-out hover:w-44 focus-within:w-44 sm:flex sm:w-14 sm:flex-col"
    >
      {items.map((item) => {
        const active = item.href === "/"
          ? pathname === "/"
          : pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={[
              "flex h-14 items-center gap-3 border-b border-[#1E1E1E] px-4 text-sm font-semibold transition last:border-b-0",
              active ? "bg-white/[0.08] text-[#F0F0F0]" : "text-[#7A7A7A] hover:bg-white/[0.04] hover:text-[#F0F0F0]",
            ].join(" ")}
          >
            <span
              className={[
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold tracking-[0.14em] transition-colors",
                active
                  ? "border-[#F0F0F0] bg-[#F0F0F0] text-[#0A0A0A]"
                  : "border-[#2A2A2A] bg-[#141414] text-[#A0A0A0] group-hover:border-[#3A3A3A]",
              ].join(" ")}
            >
              {item.glyph}
            </span>
            <span className="whitespace-nowrap opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

function AboutLink({ fixed = false }: { fixed?: boolean }) {
  return (
    <Link
      href="/about"
      className={[
        "rounded-[var(--radius-input)] border border-[#1E1E1E] px-3 py-1.5 text-xs font-semibold text-[#6B6B6B] transition hover:text-[#F0F0F0]",
        fixed ? "bg-[#0A0A0A]/80 backdrop-blur-sm" : "",
      ].join(" ")}
    >
      About
    </Link>
  );
}

function AuthCtaLink({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/sign-in"
      className={`rounded-[var(--radius-input)] border border-[#F0F0F0] bg-[#F0F0F0] px-3 py-1.5 text-xs font-semibold text-[#0A0A0A] transition hover:bg-transparent hover:text-[#F0F0F0] ${className}`}
    >
      Sign In / Sign Up
    </Link>
  );
}

function PortfolioLink({ fixed = false }: { fixed?: boolean }) {
  return (
    <Link
      href="/portfolio"
      className={[
        "rounded-[var(--radius-input)] border border-[#1E1E1E] px-3 py-1.5 text-xs font-semibold text-[#6B6B6B] transition hover:text-[#F0F0F0]",
        fixed ? "bg-[#0A0A0A]/80 backdrop-blur-sm" : "",
      ].join(" ")}
    >
      Portfolio
    </Link>
  );
}

function AuthBlock() {
  return (
    <>
      <SignedOut>
        <AuthCtaLink />
      </SignedOut>
      <SignedIn>
        <UserButton />
      </SignedIn>
    </>
  );
}

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSetsPage = pathname?.startsWith("/sets") ?? false;

  // Auth / onboarding pages get no chrome at all
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth/callback") ||
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname.startsWith("/onboarding")
  ) {
    return <>{children}</>;
  }

  // Home, search, about, and card detail pages use their own layout — no header
  if (pathname === "/" || pathname === "/search" || pathname === "/about" || pathname.startsWith("/c/")) {
    return (
      <>
        {pathname !== "/about" && (
          <div className="fixed right-4 top-4 z-50 flex items-center gap-2 sm:right-6">
            <AuthBlock />
          </div>
        )}
        <SideRail pathname={pathname} />
        {children}
      </>
    );
  }

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 border-b border-[#1E1E1E] bg-[#0A0A0A]/95">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
          {/* Logo */}
          <Link href="/" className="text-app shrink-0 text-[15px] font-bold tracking-tight">
            PopAlpha
          </Link>

          {/* Search — wrapped in Suspense because useSearchParams() requires it */}
          <Suspense
            fallback={
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div
                  className="input-themed h-9 flex-1 rounded-full opacity-40"
                  aria-hidden="true"
                />
              </div>
            }
          >
            <NavSearchForm borderless={isSetsPage} />
          </Suspense>

          {/* Right-side nav */}
          <nav className="ml-auto flex shrink-0 items-center gap-2">
            <Link
              href="/sets"
              className="hidden rounded-[var(--radius-input)] border border-[#1E1E1E] px-3 py-1.5 text-xs font-semibold text-[#6B6B6B] transition hover:text-[#F0F0F0] sm:block"
            >
              Sets
            </Link>
            {!isSetsPage ? <ThemeToggle /> : null}
            <PortfolioLink />
            <AboutLink />
            <AuthBlock />
          </nav>
        </div>
      </header>

      {/* Push content below the fixed header */}
      <div className="pt-14">{children}</div>
    </>
  );
}
