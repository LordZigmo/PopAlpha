import PortfolioClient from "./PortfolioClient";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";

export const dynamic = "force-dynamic";

export default function PortfolioPage() {
  if (!clerkEnabled) {
    return (
      <main className="app-shell min-h-screen flex items-center justify-center p-6 text-app">
        <p className="text-muted text-sm">
          Authentication is not configured. Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY to enable portfolio.
        </p>
      </main>
    );
  }

  return <PortfolioClient />;
}
