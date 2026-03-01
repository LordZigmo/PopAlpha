"use client";

import { useEffect, useState } from "react";
import CardSearch from "@/components/card-search";

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
  const [placeholder, setPlaceholder] = useState("");

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

  return (
    <main className="app-shell">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-12 sm:px-6">
        <section className="w-full max-w-2xl text-center">
          <h1 className="text-app text-6xl font-semibold tracking-tight sm:text-7xl">PopAlpha</h1>
          <p className="text-muted mx-auto mt-4 max-w-xl text-sm sm:text-base">
            Smarter TCG Market Insights.
          </p>

          <CardSearch
            className="mt-6"
            size="hero"
            placeholder={placeholder || "Search"}
            autoFocus
            enableGlobalShortcut
            submitMode="active-or-search"
          />
        </section>
      </div>
    </main>
  );
}
