"use client";

import { FormEvent, useState } from "react";

type LookupResponse = {
  ok: boolean;
  cert?: string;
  cache_hit?: boolean;
  fetched_at?: string;
  source?: string;
  data?: unknown;
  error?: string;
};

export default function Home() {
  const [cert, setCert] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResponse | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const certValue = cert.trim();
    if (!certValue) {
      setResult({ ok: false, error: "Please enter a cert number." });
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const response = await fetch(`/api/psa/cert?cert=${encodeURIComponent(certValue)}`, {
        method: "GET",
      });

      const payload = (await response.json()) as LookupResponse;
      setResult(payload);
    } catch (error) {
      setResult({ ok: false, error: String(error) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>PopAlpha PSA Cert Lookup</h1>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        Enter a PSA cert number. The server checks Supabase cache first, then calls PSA only when needed.
      </p>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          value={cert}
          onChange={(event) => setCert(event.target.value)}
          placeholder="Example: 12345678"
          style={{ flex: 1, padding: "10px 12px", fontSize: 16 }}
        />
        <button type="submit" disabled={loading} style={{ padding: "10px 14px", fontSize: 16 }}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {result && (
        <section
          style={{
            marginTop: 20,
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 16,
            background: "#fafafa",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 20 }}>Result</h2>
          {result.ok ? (
            <>
              <p style={{ margin: "4px 0" }}>
                <strong>Cert:</strong> {result.cert}
              </p>
              <p style={{ margin: "4px 0" }}>
                <strong>Source:</strong> {result.source} {result.cache_hit ? "(cache hit)" : "(fresh fetch)"}
              </p>
              <p style={{ margin: "4px 0" }}>
                <strong>Fetched at:</strong> {result.fetched_at}
              </p>
            </>
          ) : (
            <p style={{ color: "#b00020", margin: "4px 0" }}>
              <strong>Error:</strong> {result.error}
            </p>
          )}

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer" }}>Raw JSON</summary>
            <pre
              style={{
                marginTop: 10,
                overflowX: "auto",
                background: "#fff",
                border: "1px solid #e5e5e5",
                borderRadius: 6,
                padding: 12,
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </main>
  );
}
