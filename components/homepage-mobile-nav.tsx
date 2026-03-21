"use client";

import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import dynamic from "next/dynamic";

const MobileNav = dynamic(() => import("@/components/navigation/MobileNav"), {
  ssr: false,
});

export default function HomepageMobileNav() {
  if (!clerkEnabled) return null;
  return <MobileNav />;
}
