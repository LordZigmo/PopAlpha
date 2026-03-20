"use client";

import { clerkEnabled } from "@/lib/auth/clerk-enabled";

type SafeUserResult = {
  user: ReturnType<typeof import("@clerk/nextjs").useUser>["user"] | null | undefined;
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
};

/**
 * Wrapper around Clerk's useUser that returns a safe fallback
 * when ClerkProvider is not available (e.g. missing env keys).
 */
export function useSafeUser(): SafeUserResult {
  if (!clerkEnabled) {
    return { user: null, isLoaded: true, isSignedIn: false };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useUser } = require("@clerk/nextjs") as typeof import("@clerk/nextjs");
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useUser();
}
