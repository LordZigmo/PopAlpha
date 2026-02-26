"use client";

import { useEffect } from "react";

export default function CallbackClient() {
  useEffect(() => {
    (async () => {
      const { supabase } = await import("@/lib/supabaseClient");
      const url = new URL(window.location.href);

      // If Supabase uses PKCE, you'll get ?code=...
      const code = url.searchParams.get("code");
      if (code) {
        // exchanges code for a session and stores it
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
          window.location.replace("/portfolio");
          return;
        }
        window.location.replace("/login");
        return;
      }

      // Otherwise magic links often use #access_token=...
      // This reads hash tokens and stores session
      // @ts-expect-error supported by supabase-js v2
      const { data, error } = await supabase.auth.getSessionFromUrl({
        storeSession: true,
      });

      if (!error && data?.session) {
        window.location.replace("/portfolio");
        return;
      }

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