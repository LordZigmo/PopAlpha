"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import ThemeToggle from "@/components/theme-toggle";

function NavItem({ href, label, active, onClick }: { href: string; label: string; active: boolean; onClick?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`block rounded-[var(--radius-input)] border px-3 py-2 text-sm transition ${
        active ? "btn-accent" : "btn-ghost"
      }`}
    >
      {label}
    </Link>
  );
}

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const hideNav = pathname.startsWith("/login") || pathname.startsWith("/auth/callback");

  if (hideNav) return <>{children}</>;

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="app-chrome">
      <aside className="app-sidebar hidden lg:flex">
        <div className="glass h-full w-full border-r border-app p-4">
          <div className="flex items-center justify-between">
            <p className="text-app text-sm font-semibold tracking-[0.16em] uppercase">PopAlpha</p>
            <ThemeToggle />
          </div>
          <nav className="mt-5 space-y-2">
            <NavItem href="/" label="Cert Lookup" active={isActive("/")} />
            <NavItem href="/watchlist" label="Watchlist" active={isActive("/watchlist")} />
            <NavItem href="/portfolio" label="Portfolio" active={isActive("/portfolio")} />
          </nav>
        </div>
      </aside>

      <div className="lg:hidden fixed left-3 top-3 z-50 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="btn-ghost rounded-[var(--radius-input)] border px-3 py-2 text-xs font-semibold"
        >
          Menu
        </button>
        <ThemeToggle />
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 bg-black/30 lg:hidden">
          <aside className="glass h-full w-64 border-r border-app p-4">
            <p className="text-app text-sm font-semibold tracking-[0.16em] uppercase">PopAlpha</p>
            <nav className="mt-5 space-y-2">
              <NavItem href="/" label="Cert Lookup" active={isActive("/")} onClick={() => setMobileOpen(false)} />
              <NavItem href="/watchlist" label="Watchlist" active={isActive("/watchlist")} onClick={() => setMobileOpen(false)} />
              <NavItem href="/portfolio" label="Portfolio" active={isActive("/portfolio")} onClick={() => setMobileOpen(false)} />
            </nav>
          </aside>
        </div>
      ) : null}

      <main className="app-content">{children}</main>
    </div>
  );
}

