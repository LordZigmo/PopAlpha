export const dynamic = "force-dynamic";

import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import OnboardingHandleClient from "./OnboardingHandleClient";

export default function OnboardingHandlePage() {
  if (!clerkEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-white/50">Authentication is not configured.</p>
      </div>
    );
  }

  return <OnboardingHandleClient />;
}
