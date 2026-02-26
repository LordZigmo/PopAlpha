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
        <header className="mb-7">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100 sm:text-4xl">
            PopAlpha PSA Cert Lookup
          </h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
            Enter a PSA cert number and review identity, scarcity, and provenance in one polished view.
          </p>
        </header>

        <form onSubmit={onSubmit} className="card flex flex-col gap-3 rounded-2xl p-4 sm:flex-row">
          <input
            value={cert}
            onChange={(event) => setCert(event.target.value)}
            placeholder="Example: 12345678"
            className="w-full rounded-xl border border-neutral-300 bg-white/85 px-4 py-2.5 text-base text-neutral-900 placeholder:text-neutral-400 transition focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-400/50 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500 dark:focus:ring-neutral-500/40"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl border border-neutral-300 bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-400/60 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:focus:ring-neutral-500/40"
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
              <div className="card rounded-2xl border-rose-300/70 p-5 dark:border-rose-600/60">
                <h2 className="text-lg font-semibold text-rose-700 dark:text-rose-300">Lookup failed</h2>
                <p className="mt-2 text-sm text-rose-700/90 dark:text-rose-200">{result.error ?? "Unknown error"}</p>
                <RawJsonPanel value={result} />
              </div>
            )}
          </section>
        ) : null}
      </div>
    </main>
  );
}
