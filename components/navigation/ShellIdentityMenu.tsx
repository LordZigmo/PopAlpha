"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import { useSafeUser } from "@/lib/auth/use-safe-user";

type SafeSignOut = ((options?: { redirectUrl?: string }) => Promise<void>) | null;

function useSafeSignOut(): SafeSignOut {
  if (!clerkEnabled) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useClerk } = require("@clerk/nextjs") as typeof import("@clerk/nextjs");
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useClerk().signOut as SafeSignOut;
  } catch {
    return null;
  }
}

function initialsFor(name: string | null | undefined): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "P";
  return trimmed[0]?.toUpperCase() ?? "P";
}

export default function ShellIdentityMenu() {
  const { user } = useSafeUser();
  const signOut = useSafeSignOut();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const displayName = user?.fullName?.trim()
    || user?.username?.trim()
    || "PopAlpha User";
  const secondaryLabel = user?.username?.trim() ? `@${user.username.trim()}` : "Account";

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-left text-white transition hover:bg-white/[0.06]"
      >
        {user.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.imageUrl} alt={displayName} className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.08] text-[12px] font-semibold text-white">
            {initialsFor(displayName)}
          </span>
        )}
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-[12px] font-semibold text-white">{displayName}</span>
          <span className="block truncate text-[11px] text-[#6B6B6B]">{secondaryLabel}</span>
        </span>
        <ChevronDown
          size={16}
          className={`hidden text-[#6B6B6B] transition sm:block ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.75rem)] z-[70] w-[240px] overflow-hidden rounded-[1.35rem] border border-white/[0.08] bg-[#0A0A0A]/95 p-2 shadow-[0_28px_90px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        >
          <div className="rounded-[1rem] border border-white/[0.05] bg-white/[0.03] px-3 py-3">
            <p className="truncate text-[13px] font-semibold text-white">{displayName}</p>
            <p className="mt-1 truncate text-[12px] text-[#6B6B6B]">{secondaryLabel}</p>
          </div>

          <div className="mt-2 space-y-1">
            <Link
              href="/profile"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center rounded-[0.95rem] px-3 py-2.5 text-[13px] font-medium text-[#D4D4D4] transition hover:bg-white/[0.05] hover:text-white"
            >
              Profile
            </Link>
            <Link
              href="/portfolio"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center rounded-[0.95rem] px-3 py-2.5 text-[13px] font-medium text-[#D4D4D4] transition hover:bg-white/[0.05] hover:text-white"
            >
              Portfolio
            </Link>
            <Link
              href="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center rounded-[0.95rem] px-3 py-2.5 text-[13px] font-medium text-[#D4D4D4] transition hover:bg-white/[0.05] hover:text-white"
            >
              Settings
            </Link>
            {signOut ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void signOut({ redirectUrl: "/" });
                }}
                className="flex w-full items-center rounded-[0.95rem] px-3 py-2.5 text-left text-[13px] font-medium text-[#D4D4D4] transition hover:bg-white/[0.05] hover:text-white"
              >
                Sign out
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
