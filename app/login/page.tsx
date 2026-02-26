"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string>("");

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("Sending magic link…");

    const redirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback`
        : undefined;

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });

    if (error) {
      setStatus(`Error: ${error.message}`);
      return;
    }

    setStatus("Check your email for the login link.");
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 520 }}>
      <h1 className="text-3x1 font-semibold">PopAlpha</h1>
      <p style={{ opacity: 0.8, marginTop: 0 }}>
        Login via magic link.
      </p>

      <form onSubmit={sendLink} style={{ marginTop: 16 }}>
        <label style={{ display: "block", marginBottom: 8 }}>Email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          type="email"
          required
          style={{ width: "100%", padding: 10, fontSize: 16 }}
        />
        <button
          type="submit"
          style={{ marginTop: 12, padding: "10px 14px", fontSize: 16, cursor: "pointer" }}
        >
          Send magic link
        </button>
      </form>

      {status && <p style={{ marginTop: 16 }}>{status}</p>}
    </main>
  );
}