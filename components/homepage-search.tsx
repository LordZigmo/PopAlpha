"use client";

import { useEffect, useState } from "react";
import CardSearch from "@/components/card-search";

const SEARCH_EXAMPLES = [
  "Search a card, set, or cert...",
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

/**
 * Animated typewriter search for the homepage.
 * Compact variant — not full-screen hero.
 */
export default function HomepageSearch() {
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
    <CardSearch
      size="hero"
      placeholder={placeholder || "Search cards..."}
      autoFocus
      enableGlobalShortcut
      submitMode="active-or-search"
    />
  );
}
