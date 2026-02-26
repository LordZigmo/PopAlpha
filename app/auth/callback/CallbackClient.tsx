"use client";

import { useEffect } from "react";

export default function CallbackClient() {
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let timeout: number | undefined;

    (async () => {
      const { supabase } = await import("@/lib/supabaseClient");

      const go = (path: string) => window.location.replace(path);

      // 1) If session already exists, we're done.
      const { data: sess } = await supabase.auth.getSession();
      if (sess.session) {
        go("/portfolio");
        return;
      }

      const url = new URL(window.location.href);

      // 2) If PKCE code exists, exchange it.
      const code = url.searchParams.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
          go("/portfolio");
          return;
        }
        go("/login");
        return;
      }

      // 3) Otherwise, wait briefly for Supabase to finish storing session
      const { data: sub } = supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_IN") {
          go("/portfolio");
        }
      });

      cleanup = () => sub.subscription.unsubscribe();

      // Fail-safe: if nothing happens, bounce to login (or portfolio)
      timeout = window.setTimeout(async () => {
        const { data: sess2 } = await supabase.auth.getSession();
        if (sess2.session) go("/portfolio");
        else go("/login");
      }, 4000);
    })();

    return () => {
      if (cleanup) cleanup();
      if (timeout) window.clearTimeout(timeout);
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="text-muted text-sm">
        Signing you in…
      </div>
    </div>
  );
}