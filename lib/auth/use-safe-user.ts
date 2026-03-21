"use client";

import { clerkEnabled } from "@/lib/auth/clerk-enabled";

type SafeUserResult = {
  user: ReturnType<typeof import("@clerk/nextjs").useUser>["user"] | null | undefined;
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
};

const FALLBACK: SafeUserResult = { user: null, isLoaded: true, isSignedIn: false };

/**
 * Wrapper around Clerk's useUser that returns a safe fallback
 * when ClerkProvider is not available (e.g. missing env keys or
 * during static page prerendering where ClerkProvider isn't mounted).
 */
export function useSafeUser(): SafeUserResult {
  if (!clerkEnabled) {
    return FALLBACK;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useUser } = require("@clerk/nextjs") as typeof import("@clerk/nextjs");
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useUser();
  } catch {
    // ClerkProvider not mounted (e.g. during static prerender)
    return FALLBACK;
  }
}
