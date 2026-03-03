"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, UserButton, useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import PricingModal from "@/components/billing/pricing-modal";
import { Home, PieChart, UserCircle, Users } from "lucide-react";

type LinkItem = {
  href: string;
  label: string;
  icon: typeof Home;
  match: (pathname: string) => boolean;
};

const LINK_ITEMS: LinkItem[] = [
  {
    href: "/",
    label: "Home",
    icon: Home,
    match: (pathname) => pathname === "/",
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

function NavLink({
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
      className="relative block overflow-hidden rounded-[1.2rem] px-4 py-3"
    >
      {active ? (
        <motion.span
          layoutId="desktop-nav-active"
          className="absolute inset-0 rounded-[1.2rem] bg-white/[0.06]"
          transition={{ type: "spring", stiffness: 360, damping: 30 }}
        />
      ) : null}
      <span className="relative z-10 flex items-center gap-3">
        <span
          className={[
            "flex h-10 w-10 items-center justify-center rounded-[0.95rem] border",
            active
              ? "border-white/[0.08] bg-white/[0.08] text-white"
              : "border-[#1E1E1E] bg-[#0A0A0A] text-[#6B6B6B]",
          ].join(" ")}
        >
          <Icon size={19} strokeWidth={2.2} />
        </span>
        <span className={active ? "text-[15px] font-semibold text-white" : "text-[15px] font-semibold text-[#D4D4D4]"}>
          {label}
        </span>
      </span>
    </Link>
  );
}

export default function DesktopSidebar() {
  const pathname = usePathname();
  const { user } = useUser();
  const [communityOpen, setCommunityOpen] = React.useState(false);
  const [pricingOpen, setPricingOpen] = React.useState(false);
  const resolvedPath = pathname ?? "/";
  const profileHref = user ? "/profile" : "/sign-in";

  return (
    <aside className="fixed inset-y-0 right-0 z-40 hidden w-80 md:flex">
      <div className="sticky top-0 flex h-screen w-full flex-col border-l border-[#1E1E1E] bg-[#0A0A0A]/95 px-5 py-6 backdrop-blur-xl">
        <div className="mb-6 flex items-center justify-between gap-3">
          <p className="text-[18px] font-semibold tracking-[-0.03em] text-white">PopAlpha</p>
          <SignedOut>
            <Link
              href="/sign-in"
              className="rounded-2xl border border-[#1E1E1E] bg-white/[0.04] px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-white/[0.08]"
            >
              Sign In
            </Link>
          </SignedOut>
          <SignedIn>
            <UserButton />
          </SignedIn>
        </div>

        <div className="rounded-[1.7rem] border border-[#1E1E1E] bg-[#101010] p-2">
          <div className="space-y-2">
            <NavLink
              href="/"
              label="Home"
              icon={Home}
              active={resolvedPath === "/"}
            />

            <div className="rounded-[1.2rem]">
              <button
                type="button"
                onClick={() => setCommunityOpen((current) => !current)}
                className="flex w-full items-center gap-3 rounded-[1.2rem] px-4 py-3 text-left transition hover:bg-white/[0.04]"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-[0.95rem] border border-[#1E1E1E] bg-[#0A0A0A] text-[#6B6B6B]">
                  <Users size={19} strokeWidth={2.2} />
                </span>
                <span className="text-[15px] font-semibold text-[#D4D4D4]">Community</span>
              </button>

              {communityOpen ? (
                <div className="mx-2 mb-2 rounded-[1rem] border border-[#1E1E1E] bg-[#0D0D0D] px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6B6B6B]">Community Votes</p>
                  <p className="mt-2 text-[20px] font-semibold tracking-[-0.03em] text-white">10 left</p>
                  <p className="mt-1 text-[12px] text-[#8A8A8A]">10 votes allowed each week.</p>
                </div>
              ) : null}
            </div>

            <NavLink
              href="/portfolio"
              label="Portfolio"
              icon={PieChart}
              active={resolvedPath === "/portfolio" || resolvedPath.startsWith("/portfolio/")}
            />

            <NavLink
              href={profileHref}
              label="Profile"
              icon={UserCircle}
              active={
                user
                  ? resolvedPath === "/profile" || resolvedPath.startsWith("/profile/")
                  : resolvedPath === "/sign-in"
                    || resolvedPath.startsWith("/sign-in/")
                    || resolvedPath === "/sign-up"
                    || resolvedPath.startsWith("/sign-up/")
              }
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setPricingOpen(true)}
          className="relative mt-4 block overflow-hidden rounded-[1.35rem] border border-[#1E1E1E] bg-[#101010] px-4 py-4 text-left"
        >
          <motion.span
            className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/18 to-transparent"
            animate={{ x: ["0%", "360%"] }}
            transition={{ duration: 2.4, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
          />
          <span className="relative z-10 flex items-center justify-between gap-3">
            <span className="text-[14px] font-semibold tracking-[-0.01em] text-[#C9E6FF]">
              Unlock Elite
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7DBBFF]">
              Pro
            </span>
          </span>
        </button>

        <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} />
      </div>
    </aside>
  );
}
