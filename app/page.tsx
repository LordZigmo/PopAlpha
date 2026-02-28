"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const SEARCH_EXAMPLES = [
  "Start with a pokemon...",
  "Bubble Mew",
  "Base Set Charizard",
  "Paldean Fates",
  "Moonbreon",
  "Mew ex",
  "Skyridge Gengar",
  "Gold Star Rayquaza",
  "Crystal Lugia",
  "1st Edition Blastoise",
  "Shining Tyranitar",
  "Pikachu Illustrator",
  "Latias ex",
  "Team Rocket Dark Charizard",
  "Neo Genesis Lugia",
  "CoroCoro Mew",
  "Poncho Pikachu",
  "151 Charizard ex",
  "Prismatic Evolutions",
  "Evolving Skies",
  "Base Set",
  "Japanese exclusive promos",
  "PSA 10 grails",
  "Trainer Gallery",
  "Alt art chases",
];

export default function Home() {
  const router = useRouter();
  const [cert, setCert] = useState("");
  const [placeholder, setPlaceholder] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let exampleIndex = 0;
    let charIndex = 0;
    let deleting = false;

    const tick = () => {
      const current = SEARCH_EXAMPLES[exampleIndex] ?? "";
      if (!deleting) {
        charIndex += 1;
        setPlaceholder(current.slice(0, charIndex));
        if (charIndex >= current.length) {
          deleting = true;
          timeoutId = setTimeout(tick, exampleIndex === 0 ? 6000 : 1400);
          return;
        }
        timeoutId = setTimeout(tick, 75);
        return;
      }

      charIndex = Math.max(0, charIndex - 1);
      setPlaceholder(current.slice(0, charIndex));
      if (charIndex === 0) {
        deleting = false;
        exampleIndex = (exampleIndex + 1) % SEARCH_EXAMPLES.length;
        timeoutId = setTimeout(tick, 180);
        return;
      }
      timeoutId = setTimeout(tick, 45);
    };

    timeoutId = setTimeout(tick, 300);
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
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
          <p className="text-muted mx-auto mt-4 max-w-xl text-sm sm:text-base">
            A financial engine for alternative assets, built to price, track, and surface signal across collectible cards.
          </p>

          <div className="mt-6 flex items-center justify-center gap-4">
            <Link href="/sets" className="text-muted text-sm transition-colors hover:text-app underline underline-offset-4">
              Browse Sets
            </Link>
          </div>

          <form onSubmit={onSubmit} className="mt-6 flex items-center gap-2">
            <input
              ref={inputRef}
              value={cert}
              onChange={(event) => setCert(event.target.value)}
              placeholder={placeholder || "Search"}
              className="input-themed h-14 w-full rounded-full px-6 text-base"
              autoFocus
            />
            <button type="submit" className="btn-accent h-14 rounded-full px-6 text-sm font-semibold">
              Search
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
