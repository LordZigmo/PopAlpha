"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";

export const dynamic = "force-dynamic";

export default function AuthCallbackPage() {
  useEffect(() => {
    supabase.auth.getSession().finally(() => {
      window.location.replace("/portfolio");
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