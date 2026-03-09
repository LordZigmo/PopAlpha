"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import { Camera, Home, PieChart, UserCircle, Users } from "lucide-react";
import { POKETRACE_CAMERA_HREF } from "@/lib/poketrace/ui-paths";

type NavTab = {
  href: string;
  label: string;
  icon: typeof Home;
  match: (pathname: string) => boolean;
};

const TABS: NavTab[] = [
  {
    href: "/",
    label: "Home",
    icon: Home,
    match: (pathname) => pathname === "/",
  },
  {
    href: "/search",
    label: "Community",
    icon: Users,
    match: (pathname) => pathname === "/search" || pathname.startsWith("/search/"),
  },
  {
    href: "/portfolio",
    label: "Portfolio",
    icon: PieChart,
    match: (pathname) => pathname === "/portfolio" || pathname.startsWith("/portfolio/"),
  },
  {
    href: "/profile",
    label: "Profile",
    icon: UserCircle,
    match: (pathname) =>
      pathname === "/profile"
      || pathname.startsWith("/profile/")
      || pathname === "/sign-in"
      || pathname.startsWith("/sign-in/")
      || pathname === "/sign-up"
      || pathname.startsWith("/sign-up/"),
  },
];

const SIGNED_OUT_PROFILE_MATCH = (pathname: string) =>
      pathname === "/sign-in"
      || pathname.startsWith("/sign-in/")
      || pathname === "/sign-up"
      || pathname.startsWith("/sign-up/");

function TabLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: typeof Home;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-2xl px-2 py-2 text-center transition-colors hover:bg-white/[0.04]"
    >
      <Icon
        className={active ? "text-[#F0F0F0]" : "text-[#6B6B6B]"}
        size={20}
        strokeWidth={2.2}
      />
      <span
        className={[
          "truncate text-[11px] font-semibold tracking-[-0.01em]",
          active ? "text-[#F0F0F0]" : "text-[#6B6B6B]",
        ].join(" ")}
      >
        {label}
      </span>
    </Link>
  );
}

export default function MobileNav() {
  const pathname = usePathname();
  const { user } = useUser();
  const resolvedPath = pathname ?? "/";
  const profileHref = user ? "/profile" : "/sign-in";

  return (
    <nav
      aria-label="Primary mobile navigation"
      className="fixed inset-x-4 bottom-3 z-50 flex md:hidden"
    >
      <div className="relative grid w-full grid-cols-5 items-end rounded-[2rem] border border-[#1E1E1E] bg-[#0A0A0A]/88 px-2 pt-2 shadow-[0_24px_70px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div className="flex items-end pb-[max(env(safe-area-inset-bottom),0.5rem)]">
          <TabLink
            href={TABS[0].href}
            label={TABS[0].label}
            icon={TABS[0].icon}
            active={TABS[0].match(resolvedPath)}
          />
        </div>

        <div className="flex items-end pb-[max(env(safe-area-inset-bottom),0.5rem)]">
          <TabLink
            href={TABS[1].href}
            label={TABS[1].label}
            icon={TABS[1].icon}
            active={TABS[1].match(resolvedPath)}
          />
        </div>

        <div className="flex items-start justify-center">
          <motion.div
            whileTap={{ scale: 0.92, y: 2 }}
            transition={{ type: "spring", stiffness: 520, damping: 26 }}
            className="-mt-7"
          >
            <Link
              href={POKETRACE_CAMERA_HREF}
              aria-label="Open Poketrace camera"
              className="flex h-16 w-16 items-center justify-center rounded-[1.6rem] border border-[#5BA2FF]/35 bg-gradient-to-br from-[#1D4ED8] to-[#312E81] shadow-[0_20px_45px_rgba(29,78,216,0.38)]"
            >
              <Camera className="text-white" size={26} strokeWidth={2.3} />
            </Link>
          </motion.div>
        </div>

        <div className="flex items-end pb-[max(env(safe-area-inset-bottom),0.5rem)]">
          <TabLink
            href={TABS[2].href}
            label={TABS[2].label}
            icon={TABS[2].icon}
            active={TABS[2].match(resolvedPath)}
          />
        </div>

        <div className="flex items-end pb-[max(env(safe-area-inset-bottom),0.5rem)]">
          <TabLink
            href={profileHref}
            label={TABS[3].label}
            icon={TABS[3].icon}
            active={user ? TABS[3].match(resolvedPath) : SIGNED_OUT_PROFILE_MATCH(resolvedPath)}
          />
        </div>
      </div>
    </nav>
  );
}
