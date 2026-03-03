"use client";

import DesktopSidebar from "@/components/navigation/DesktopSidebar";
import MobileNav from "@/components/navigation/MobileNav";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-transparent">
      <DesktopSidebar />
      <main className="min-h-screen pb-24 md:pr-80">
        {children}
      </main>
      <MobileNav />
    </div>
  );
}
