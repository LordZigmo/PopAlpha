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
    <main className="app-shell min-h-screen flex items-center justify-center p-6 text-app">
      <div className="card w-full max-w-md rounded-2xl p-6">
        <div className="mb-5">
          <h1 className="text-3xl font-semibold tracking-tight">PopAlpha</h1>
          <p className="text-muted mt-1 text-sm">
            Login via magic link.
          </p>

          {/* TEMP DEBUG — remove after redirect works */}
          <p className="text-muted mt-2 break-all text-xs">
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
              className="input-themed w-full rounded-xl px-3 py-2 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={sending}
            className="btn-accent w-full rounded-xl px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
          >
            {sending ? "Sending…" : "Send magic link"}
          </button>
        </form>

        {status && (
          <p className="text-app mt-4 text-sm">
            {status}
          </p>
        )}
      </div>
    </main>
  );
}