"use client";

import DesktopLeftRail from "@/components/navigation/DesktopLeftRail";
import DesktopSidebar from "@/components/navigation/DesktopSidebar";
import MobileNav from "@/components/navigation/MobileNav";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-transparent">
      <DesktopLeftRail />
      <DesktopSidebar />
      <main className="min-h-screen pb-24 md:pl-[min(30vw,22rem)] md:pr-80">
        <div className="md:mx-auto md:w-full md:max-w-[calc(100vw-min(30vw,22rem)-20rem)]">
          {children}
        </div>
      </main>
      <MobileNav />
    </div>
  );
}
