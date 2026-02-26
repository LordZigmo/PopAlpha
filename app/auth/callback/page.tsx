"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

function parseHashParams(hash: string) {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(h);
  return {
    access_token: params.get("access_token"),
    refresh_token: params.get("refresh_token"),
  };
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const [msg, setMsg] = useState("Finishing sign-in…");

  useEffect(() => {
    (async () => {
      // If session already exists, go to portfolio
      const existing = await supabase.auth.getSession();
      if (existing.data.session) {
        router.replace("/portfolio");
        return;
      }

      const { access_token, refresh_token } = parseHashParams(window.location.hash);

      if (!access_token || !refresh_token) {
        setMsg("Missing auth tokens. Try logging in again.");
        return;
      }

      const { error } = await supabase.auth.setSession({
        access_token,
        refresh_token,
      });

      if (error) {
        setMsg(`Auth error: ${error.message}`);
        return;
      }

      // Remove tokens from the URL
      window.history.replaceState({}, document.title, "/auth/callback");

      router.replace("/portfolio");
    })();
  }, [router]);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>PopAlpha</h1>
      <p>{msg}</p>
    </main>
  );
}