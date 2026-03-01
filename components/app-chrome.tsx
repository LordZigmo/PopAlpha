"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/theme-toggle";
import StyleToggle from "@/components/style-toggle";
import NavSearchForm from "@/components/nav-search-form";

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Auth pages get no chrome at all
  if (pathname.startsWith("/login") || pathname.startsWith("/auth/callback")) {
    return <>{children}</>;
  }

  // Home, search, and card detail pages use their own layout — no header
  if (pathname === "/" || pathname === "/search" || pathname.startsWith("/c/")) {
    return (
      <>
        <div className="fixed right-4 top-4 z-[60]">
          <StyleToggle />
        </div>
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
            <NavSearchForm />
          </Suspense>

          {/* Right-side nav */}
          <nav className="ml-auto flex shrink-0 items-center gap-2">
            <Link
              href="/sets"
              className="hidden rounded-[var(--radius-input)] border border-[#1E1E1E] px-3 py-1.5 text-xs font-semibold text-[#6B6B6B] transition hover:text-[#F0F0F0] sm:block"
            >
              Sets
            </Link>
            <StyleToggle />
            <ThemeToggle />
          </nav>
        </div>
      </header>

      {/* Push content below the fixed header */}
      <div className="pt-14">{children}</div>
    </>
  );
}
