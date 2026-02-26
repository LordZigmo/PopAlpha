"use client";

import CertDetailsCard from "@/components/cert-details-card";
import CertSkeleton from "@/components/cert-skeleton";
import RawJsonPanel from "@/components/raw-json-panel";
import ThemeToggle from "@/components/theme-toggle";
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

function StubIconButton({ label, icon }: { label: string; icon: string }) {
  return (
    <button
      type="button"
      className="btn-ghost inline-flex h-10 w-10 items-center justify-center rounded-full text-sm"
      aria-label={label}
      title={label}
    >
      <span aria-hidden>{icon}</span>
    </button>
  );
}

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
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <section className="glass rounded-[1.75rem] border-app border p-4 sm:p-6">
          <header className="mb-5">
            <h1 className="text-app text-2xl font-semibold tracking-tight sm:text-3xl">PopAlpha PSA Cert Lookup</h1>
            <p className="text-muted mt-2 text-sm">
              Search a cert and review profile-grade identity, population stats, and market context in one dashboard.
            </p>
          </header>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <form onSubmit={onSubmit} className="flex w-full flex-1 items-center gap-2">
              <input
                value={cert}
                onChange={(event) => setCert(event.target.value)}
                placeholder="Search by cert number (example: 12345678)"
                className="input-themed h-12 w-full rounded-full px-5 text-base transition"
              />
              <button
                type="submit"
                disabled={loading}
                className="btn-accent h-12 rounded-full px-5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Searching…" : "Search"}
              </button>
            </form>

            <div className="flex items-center gap-2">
              <ThemeToggle />
              <StubIconButton label="Copy link" icon="🔗" />
              <StubIconButton label="Save" icon="💾" />
              <StubIconButton label="Add private sale" icon="➕" />
            </div>
          </div>
        </section>

        {loading ? <CertSkeleton /> : null}

        {result ? (
          <section className="results-enter mt-6">
            {result.ok && result.cert && result.data ? (
              <CertDetailsCard
                cert={result.cert}
                data={result.data}
                source={result.source}
                cacheHit={result.cache_hit}
                fetchedAt={result.fetched_at}
                rawLookup={result}
              />
            ) : (
              <div className="glass rounded-2xl border-app border p-5">
                <h2 className="text-negative text-lg font-semibold">Lookup failed</h2>
                <p className="text-negative mt-2 text-sm">{result.error ?? "Unknown error"}</p>
                <RawJsonPanel value={result} className="mt-4" />
              </div>
            )}
          </section>
        ) : null}
      </div>
    </main>
  );
}
