"use client";

import CertDetailsCard from "@/components/cert-details-card";
import CertSkeleton from "@/components/cert-skeleton";
import RawJsonPanel from "@/components/raw-json-panel";
import type { CertificateResponse } from "@/lib/psa/client";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { addCert, isSavedCert, listCerts, removeCert, watchlistCount, type WatchCertEntry } from "@/lib/watchlist";

type LookupResponse = {
  ok: boolean;
  cert?: string;
  cache_hit?: boolean;
  fetched_at?: string;
  source?: string;
  data?: CertificateResponse;
  error?: string;
};

type ToastState = {
  kind: "success" | "error";
  message: string;
};


function StubIconButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="btn-ghost inline-flex h-10 w-10 items-center justify-center rounded-full text-sm disabled:cursor-not-allowed disabled:opacity-55"
      aria-label={label}
      title={label}
    >
      <span aria-hidden>{icon}</span>
    </button>
  );
}

function getTitle(data?: CertificateResponse): string {
  if (!data) return "";
  const parts = [data.parsed.year, data.parsed.subject, data.parsed.variety].filter(
    (part) => typeof part === "string" && part.trim() !== ""
  );
  return parts.join(" • ");
}

export default function CertTerminalView({ initialCert }: { initialCert: string }) {
  const router = useRouter();
  const [cert, setCert] = useState(initialCert);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResponse | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [watchCerts, setWatchCerts] = useState<WatchCertEntry[]>([]);
  const [totalWatched, setTotalWatched] = useState(0);

  useEffect(() => {
    setWatchCerts(listCerts());
    setTotalWatched(watchlistCount());
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadedCert = result?.ok ? result.cert ?? "" : "";

  const isSaved = useMemo(() => {
    if (!loadedCert) return false;
    return watchCerts.some((item) => item.cert === loadedCert);
  }, [loadedCert, watchCerts]);

  async function fetchCert(certValue: string) {
    if (!certValue) {
      setResult({ ok: false, error: "Please enter a cert number." });
      return;
    }

    setCert(certValue);
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

  useEffect(() => {
    setCert(initialCert);
    void fetchCert(initialCert);
  }, [initialCert]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const certValue = cert.trim();
    if (!certValue) {
      setToast({ kind: "error", message: "Please enter a cert number." });
      return;
    }
    if (certValue !== initialCert) {
      router.push(`/cert/${encodeURIComponent(certValue)}`);
      return;
    }
    await fetchCert(certValue);
  }

  async function copyCurrentLink() {
    const currentCert = loadedCert || cert.trim() || initialCert;
    if (!currentCert) {
      setToast({ kind: "error", message: "Search a cert first so there is a link to copy." });
      return;
    }

    const copyUrl = `${window.location.origin}/cert/${encodeURIComponent(currentCert)}`;

    try {
      await navigator.clipboard.writeText(copyUrl);
      setToast({ kind: "success", message: "Cert link copied to clipboard." });
    } catch {
      setToast({ kind: "error", message: "Could not copy link. Please copy from your browser address bar." });
    }
  }

  function toggleWatchlist() {
    if (!loadedCert || !result?.ok || !result.data) {
      setToast({ kind: "error", message: "Load a cert first before saving to watchlist." });
      return;
    }
    const next = isSavedCert(loadedCert)
      ? removeCert(loadedCert)
      : addCert({
          cert: loadedCert,
          label: getTitle(result.data),
          grade: result.data.parsed.grade ?? "",
        });
    setWatchCerts(next);
    setTotalWatched(watchlistCount());
    const nowSaved = next.some((item) => item.cert === loadedCert);
    setToast({ kind: "success", message: nowSaved ? "Saved to watchlist." : "Removed from watchlist." });
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
            <p className="text-muted mt-2 text-xs">Watchlist items: {totalWatched}</p>
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
              <StubIconButton label="Copy link" icon="🔗" onClick={copyCurrentLink} />
              <StubIconButton label="Add private sale" icon="➕" disabled={!loadedCert} />
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
                watchlistSaved={isSaved}
                onToggleWatchlist={toggleWatchlist}
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

      {toast ? (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div
            className={`glass rounded-full border px-4 py-2 text-sm font-medium ${
              toast.kind === "success" ? "border-emerald-500/20 text-positive" : "border-rose-500/20 text-negative"
            }`}
            role="status"
            aria-live="polite"
          >
            {toast.message}
          </div>
        </div>
      ) : null}
    </main>
  );
}
