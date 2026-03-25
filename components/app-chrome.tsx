"use client";

import { usePathname } from "next/navigation";
import { useSafeUser } from "@/lib/auth/use-safe-user";
import AppShell from "@/components/layout/AppShell";
import SiteHeader from "@/components/site-header";

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useSafeUser();

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

  // Search and card detail pages use their own layout — no shared default header
  if (pathname === "/search" || pathname.startsWith("/c/")) {
    return (
      <AppShell>
        {children}
      </AppShell>
    );
  }

  return (
    <AppShell>
      <SiteHeader
        showSignIn={!user}
        primaryCta={user ? { label: "Profile", href: "/profile" } : { label: "Start free", href: "/sign-up" }}
        innerClassName="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8 md:max-w-[calc(100vw-min(30vw,22rem)-20rem)]"
      />

      {/* Push content below the fixed header */}
      <div className="pt-16">{children}</div>
    </AppShell>
  );
}
