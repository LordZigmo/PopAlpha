"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string>("");
  const [sending, setSending] = useState(false);

  const redirectTo =
    process.env.NEXT_PUBLIC_SITE_URL
      ? `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`
      : typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback`
        : "";

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setStatus("Sending magic link…");

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });

    if (error) {
      setStatus(`Error: ${error.message}`);
      setSending(false);
      return;
    }

    setStatus("Check your email for the login link.");
    setSending(false);
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-50">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-5">
          <h1 className="text-3xl font-semibold tracking-tight">PopAlpha</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
            Login via magic link.
          </p>

          {/* TEMP DEBUG — remove after redirect works */}
          <p className="mt-2 text-xs text-neutral-500 break-all">
            Redirect: {redirectTo || "(empty)"}
          </p>
        </div>

        <form onSubmit={sendLink} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              type="email"
              required
              className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none
                         focus:ring-2 focus:ring-neutral-300 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:ring-neutral-700"
            />
          </div>

          <button
            type="submit"
            disabled={sending}
            className="w-full rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white
                       hover:bg-neutral-800 disabled:opacity-60 disabled:cursor-not-allowed
                       dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {sending ? "Sending…" : "Send magic link"}
          </button>
        </form>

        {status && (
          <p className="mt-4 text-sm text-neutral-700 dark:text-neutral-200">
            {status}
          </p>
        )}
      </div>
    </main>
  );
}