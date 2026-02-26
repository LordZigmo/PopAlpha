"use client";

import { useEffect } from "react";

export default function CallbackClient() {
  useEffect(() => {
    // Dynamically import Supabase at runtime only
    import("@/lib/supabaseClient").then(({ supabase }) => {
      supabase.auth.getSession().finally(() => {
        window.location.replace("/portfolio");
      });
    });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="text-sm text-neutral-600 dark:text-neutral-300">
        Signing you in…
      </div>
    </div>
  );
}