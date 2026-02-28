"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const examples = ["23000982", "Pikachu", "Bubble Mew", "Base Set Charizard"];

export default function Home() {
  const router = useRouter();
  const [cert, setCert] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/") {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        event.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown as unknown as EventListener);
    return () => window.removeEventListener("keydown", onKeyDown as unknown as EventListener);
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const certValue = cert.trim();
    if (!certValue) return;
    if (/^\d+$/.test(certValue)) {
      router.push(`/cert/${encodeURIComponent(certValue)}`);
      return;
    }
    router.push(`/search?q=${encodeURIComponent(certValue)}`);
  }

  return (
    <main className="app-shell">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-12 sm:px-6">
        <section className="w-full max-w-2xl text-center">
          <h1 className="text-app text-5xl font-semibold tracking-tight sm:text-6xl">PopAlpha</h1>
          <p className="text-muted mt-3 text-sm sm:text-base">Search canonical cards, decks, and cert-backed profiles in one place.</p>
          <p className="text-muted mt-2 text-xs sm:text-sm">Look up a cert number, a card name, a nickname, or a set + number combination.</p>

          <form onSubmit={onSubmit} className="mt-8 flex items-center gap-2">
            <input
              ref={inputRef}
              value={cert}
              onChange={(event) => setCert(event.target.value)}
              placeholder="Search cert, card, deck, or alias"
              className="input-themed h-14 w-full rounded-full px-6 text-base"
              autoFocus
            />
            <button type="submit" className="btn-accent h-14 rounded-full px-6 text-sm font-semibold">
              Search
            </button>
          </form>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs">
            {examples.map((example) => (
              <Link
                key={example}
                href={/^\d+$/.test(example) ? `/cert/${encodeURIComponent(example)}` : `/search?q=${encodeURIComponent(example)}`}
                className="btn-ghost rounded-full border px-3 py-1.5"
              >
                {example}
              </Link>
            ))}
          </div>

          <div className="mt-8 grid gap-3 text-left sm:grid-cols-3">
            <div className="glass rounded-[var(--radius-card)] border-app border p-4">
              <p className="text-app text-sm font-semibold">Canonical Search</p>
              <p className="text-muted mt-1 text-xs">Find card profiles by name, alias, or subject and browse image-first results.</p>
            </div>
            <div className="glass rounded-[var(--radius-card)] border-app border p-4">
              <p className="text-app text-sm font-semibold">Market Context</p>
              <p className="text-muted mt-1 text-xs">View PopAlpha listing signals alongside TCG market snapshots on canonical pages.</p>
            </div>
            <div className="glass rounded-[var(--radius-card)] border-app border p-4">
              <p className="text-app text-sm font-semibold">Cert Lookup</p>
              <p className="text-muted mt-1 text-xs">Jump straight to cert-backed profiles when you already know the certification number.</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
