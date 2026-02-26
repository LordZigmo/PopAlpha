"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Home() {
  const [status, setStatus] = useState<string>("Checking Supabase…");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.getSession();

      if (error) {
        setStatus(`Supabase error: ${error.message}`);
        return;
      }

      setStatus(
        `Supabase connected. Session: ${data.session ? "Yes" : "No"}`
      );
    })();
  }, []);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 28 }}>PopAlpha</h1>
      <p>{status}</p>
      <p style={{ opacity: 0.7 }}>
        If you see “Supabase connected”, the integration works.
      </p>
    </main>
  );
}