"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import ThemeToggle from "@/components/theme-toggle";

function NavItem({
  href,
  label,
  active,
  onClick,
  compact = false,
}: {
  href: string;
  label: string;
  active: boolean;
  onClick?: () => void;
  compact?: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`block rounded-[var(--radius-input)] border ${compact ? "px-3 py-2 text-xs" : "px-3 py-2 text-sm"} transition ${
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
  const showFloatingNav = pathname.startsWith("/cert/");

  if (hideNav) return <>{children}</>;

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="app-chrome">
      {showFloatingNav ? (
        <div className="hidden lg:flex fixed right-4 top-4 z-50 items-center gap-2">
          <NavItem href="/" label="Lookup" active={isActive("/")} compact />
          <NavItem href="/watchlist" label="Watchlist" active={isActive("/watchlist")} compact />
          <NavItem href="/portfolio" label="Portfolio" active={isActive("/portfolio")} compact />
          <ThemeToggle />
        </div>
      ) : null}

      {showFloatingNav ? (
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
      ) : null}

      {showFloatingNav && mobileOpen ? (
        <div className="fixed inset-0 z-40 bg-black/30 lg:hidden">
          <aside className="glass ml-3 mt-14 w-56 rounded-[var(--radius-panel)] border-app border p-3">
            <nav className="space-y-2">
              <NavItem href="/" label="Cert Lookup" active={isActive("/")} onClick={() => setMobileOpen(false)} />
              <NavItem href="/watchlist" label="Watchlist" active={isActive("/watchlist")} onClick={() => setMobileOpen(false)} />
              <NavItem href="/portfolio" label="Portfolio" active={isActive("/portfolio")} onClick={() => setMobileOpen(false)} />
            </nav>
          </aside>
        </div>
      ) : null}
      <main>{children}</main>
    </div>
  );
}
