"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/theme-toggle";
import NavSearchForm from "@/components/nav-search-form";

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Auth pages get no chrome at all
  if (pathname.startsWith("/login") || pathname.startsWith("/auth/callback")) {
    return <>{children}</>;
  }

  // Home page keeps its full-screen search hero — no header needed
  if (pathname === "/") {
    return <>{children}</>;
  }

  return (
    <>
      <header
        className="fixed inset-x-0 top-0 z-50"
        style={{
          borderBottom: "1px solid var(--color-border)",
          background: "color-mix(in srgb, var(--color-surface) 92%, transparent)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      >
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
          {/* Logo */}
          <Link href="/" className="text-app shrink-0 text-sm font-semibold tracking-tight">
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
              className="btn-ghost hidden rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold sm:block"
            >
              Sets
            </Link>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      {/* Push content below the fixed header */}
      <div className="pt-14">{children}</div>
    </>
  );
}
