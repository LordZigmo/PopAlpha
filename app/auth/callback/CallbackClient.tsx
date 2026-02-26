"use client";

import { useEffect } from "react";

export default function CallbackClient() {
  useEffect(() => {
    (async () => {
      const { supabase } = await import("@/lib/supabaseClient");

      // 1) If the URL has a hash token (#access_token=...), this will store the session.
      // 2) If there's no token, it won't crash; we’ll just fall through.
      try {
        // @ts-expect-error getSessionFromUrl exists in supabase-js v2
        const { data, error } = await supabase.auth.getSessionFromUrl({
          storeSession: true,
        });

        if (error) {
          // If it fails, send them to login
          window.location.replace("/login");
          return;
        }

        // If session exists after consuming URL, go to portfolio
        if (data?.session) {
          window.location.replace("/portfolio");
          return;
        }
      } catch {
        // If method doesn't exist (rare), fallback to login
        window.location.replace("/login");
        return;
      }

      // If nothing was in the URL, go to login
      window.location.replace("/login");
    })();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="text-sm text-neutral-600 dark:text-neutral-300">
        Signing you in…
      </div>
    </div>
  );
}