"use client";

import CertDetailsCard from "@/components/cert-details-card";
import CertSkeleton from "@/components/cert-skeleton";
import RawJsonPanel from "@/components/raw-json-panel";
import { FormEvent, useState } from "react";
import type { CertificateResponse } from "@/lib/psa/client";

type LookupResponse = {
  ok: boolean;
  cert?: string;
  cache_hit?: boolean;
  fetched_at?: string;
  source?: string;
  data?: CertificateResponse;
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
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <header className="mb-7 pr-28">
          <h1 className="text-app text-3xl font-semibold tracking-tight sm:text-4xl">PopAlpha PSA Cert Lookup</h1>
          <p className="text-muted mt-2 text-sm">
            Enter a PSA cert number and review identity, scarcity, and provenance in one polished view.
          </p>
        </header>

        <form onSubmit={onSubmit} className="card flex flex-col gap-3 rounded-2xl p-4 sm:flex-row">
          <input
            value={cert}
            onChange={(event) => setCert(event.target.value)}
            placeholder="Example: 12345678"
            className="input-themed w-full rounded-xl px-4 py-2.5 text-base transition"
          />
          <button
            type="submit"
            disabled={loading}
            className="btn-accent rounded-xl px-5 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </form>

        {loading ? <CertSkeleton /> : null}

        {result ? (
          <section className="results-enter mt-6">
            {result.ok && result.cert && result.data ? (
              <>
                <CertDetailsCard
                  cert={result.cert}
                  data={result.data}
                  source={result.source}
                  cacheHit={result.cache_hit}
                  fetchedAt={result.fetched_at}
                />
                <RawJsonPanel value={result} />
              </>
            ) : (
              <div className="card rounded-2xl p-5">
                <h2 className="text-negative text-lg font-semibold">Lookup failed</h2>
                <p className="text-negative mt-2 text-sm">{result.error ?? "Unknown error"}</p>
                <RawJsonPanel value={result} />
              </div>
            )}
          </section>
        ) : null}
      </div>
    </main>
  );
}
