"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import { useSafeUser } from "@/lib/auth/use-safe-user";

// ----------------------------------------------------------------------
// PostHog initialization
//
// We initialize synchronously at module-load (client-side only) rather
// than relying on Next.js 16 / Turbopack to auto-load
// instrumentation-client.ts — that convention is fragile in current
// Turbopack dev builds and leaves `window.posthog` undefined, which
// silently breaks every posthog.capture() call in the app.
//
// Using a `"use client"` component mounted by the root layout guarantees
// this code runs exactly once per page load. The window-scoped flag
// prevents double-init if instrumentation-client.ts ever does auto-load
// (e.g. after a Next.js patch release).
// ----------------------------------------------------------------------

declare global {
  interface Window {
    __POSTHOG_INITIALIZED__?: boolean;
    posthog?: typeof posthog;
  }
}

if (typeof window !== "undefined" && !window.__POSTHOG_INITIALIZED__) {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (token) {
    posthog.init(token, {
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      defaults: "2026-01-30",
      capture_exceptions: true,
      debug: process.env.NODE_ENV === "development",
    });
    window.__POSTHOG_INITIALIZED__ = true;
    // Expose the client on window so it's accessible from the browser
    // console for manual debugging (e.g. `window.posthog.capture('x')`).
    // posthog-js does not attach itself to window automatically.
    window.posthog = posthog as unknown as Window["posthog"];
  } else if (process.env.NODE_ENV === "development") {
    // eslint-disable-next-line no-console
    console.warn(
      "[PostHog] NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is not set — " +
        "PostHog will not initialize and no events will be captured.",
    );
  }
}

/**
 * Keeps PostHog's distinct_id in sync with the signed-in Clerk user on
 * every page. The onboarding handle flow already calls posthog.identify()
 * once when a new user claims their handle — this component covers the
 * other ~95% of sessions: returning users, users who skipped onboarding,
 * and page navigations after sign-in.
 *
 * On sign-out it calls posthog.reset() so the next events are attributed
 * to a fresh anonymous id rather than leaking to the previous user.
 */
export default function PostHogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isLoaded } = useSafeUser();
  // Tracks the last Clerk user id we synced to PostHog so we only call
  // identify()/reset() on actual transitions, not every render.
  const lastSyncedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;

    const currentId = user?.id ?? null;
    if (currentId === lastSyncedIdRef.current) return;

    if (currentId) {
      posthog.identify(currentId, {
        email: user?.primaryEmailAddress?.emailAddress ?? undefined,
        first_name: user?.firstName ?? undefined,
      });
    } else {
      // Signed out (or never signed in after a previous identify in this
      // session) — reset the distinct_id so subsequent events don't
      // attribute to the previous user.
      posthog.reset();
    }

    lastSyncedIdRef.current = currentId;
  }, [
    isLoaded,
    user?.id,
    user?.primaryEmailAddress?.emailAddress,
    user?.firstName,
  ]);

  return <>{children}</>;
}
