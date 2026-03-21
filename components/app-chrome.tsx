"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { SignedOut } from "@clerk/nextjs";
import AppShell from "@/components/layout/AppShell";
import ThemeToggle from "@/components/theme-toggle";
import NavSearchForm from "@/components/nav-search-form";

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
    <SignedOut>
      <AuthCtaLink />
    </SignedOut>
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

  // Landing page gets no chrome at all — it has its own full-width layout
  if (pathname === "/") {
    return <>{children}</>;
  }

  // Search, about, and card detail pages use their own layout — no header
  if (pathname === "/search" || pathname === "/about" || pathname.startsWith("/c/")) {
    return (
      <AppShell>
        {children}
      </AppShell>
    );
  }

  return (
    <AppShell>
      <header className="fixed inset-x-0 top-0 z-50 border-b border-[#1E1E1E] bg-[#0A0A0A]/95">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6 md:max-w-[calc(100vw-min(30vw,22rem)-20rem)] md:px-6">
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
    </AppShell>
  );
}
