"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const examples = ["23000982", "12345678", "71870967"];

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
    router.push(`/cert/${encodeURIComponent(certValue)}`);
  }

  return (
    <main className="app-shell">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-12 sm:px-6">
        <section className="w-full max-w-2xl text-center">
          <h1 className="text-app text-5xl font-semibold tracking-tight sm:text-6xl">PopAlpha</h1>
          <p className="text-muted mt-3 text-sm sm:text-base">Enter a PSA cert number</p>

          <form onSubmit={onSubmit} className="mt-8 flex items-center gap-2">
            <input
              ref={inputRef}
              value={cert}
              onChange={(event) => setCert(event.target.value)}
              placeholder="Search cert number"
              className="input-themed h-14 w-full rounded-full px-6 text-base"
              autoFocus
            />
            <button type="submit" className="btn-accent h-14 rounded-full px-6 text-sm font-semibold">
              Search
            </button>
          </form>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs">
            {examples.map((example) => (
              <Link key={example} href={`/cert/${example}`} className="btn-ghost rounded-full border px-3 py-1.5">
                {example}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
